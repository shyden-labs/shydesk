/**
 * Real input on every target (shyden-labs/shydesk#42 AC4). Tests call these
 * and never a driver directly, so one test runs unchanged everywhere:
 *
 * - desktop: WebDriver clicks and key presses, which the browser receives as
 *   trusted input; a file goes in through the file input, WebDriver's way to
 *   the file chooser.
 * - phones: Appium's native layer, measured 2026-11-05/06 on the real phones:
 *   a real touch on the control, real key presses, and the phone's own photo
 *   picker opening the "ShyDesk tests" album (iPhone) or the ShyDeskTests
 *   folder (Android) that holds only the test files.
 *
 * Controls are found by their accessible name, the same on every target. A
 * step that cannot happen fails naming what was missing.
 */
import { driver } from './driver.ts';
import { named } from './find.ts';
import { resolve } from 'node:path';
import {
  ANDROID_PAGE,
  nativeFinder,
  pickerItem,
  screenPoint,
  targetOf,
  sameBox,
  scrollInput,
  scrollKey,
  scrollNeeded,
  viewportPoint,
  type Box,
  type Fixture,
  type Phone,
} from './targets.ts';

const WAIT = 15_000;

/** Page Down presses allowed to bring a control into view: more than any test page is long. */
const PAGE_KEYS = 20;

function phone(): Phone | undefined {
  const target = targetOf(driver().capabilities);
  return target === 'android' || target === 'ios' ? target : undefined;
}

/** Runs `step` in the phone's native layer, then returns to the page. */
async function native<T>(step: () => Promise<T>): Promise<T> {
  const page = await driver().getContext();
  await driver().switchContext('NATIVE_APP');
  try {
    return await step();
  } finally {
    await driver().switchContext(typeof page === 'string' ? page : page.id);
  }
}

async function nativeTap(on: Phone, selector: string, what: string): Promise<void> {
  const element = driver().$(selector);
  await element.waitForExist({ timeout: WAIT, timeoutMsg: `${on}: ${what} never appeared (${selector})` });
  await element.click();
}

/**
 * A real mouse press where the page draws the element named `label`. Safari's
 * Element Click cannot reach inside a shadow root (WebKit bug 202589; "click
 * intercepted" on PR shyden-labs/shydesk#69), so every desktop target presses
 * the mouse at the element's middle instead, as a person would, after a real
 * wheel scroll when the element is outside the window.
 */
async function clickDrawn(label: string): Promise<void> {
  const element = await named(label);
  // Reads where the element is drawn; the input itself is the real wheel and mouse actions below.
  const drawn = (): Promise<{ box: Box; viewport: { width: number; height: number } }> =>
    driver().execute(
      'const r = arguments[0].getBoundingClientRect(); return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, viewport: { width: window.innerWidth, height: window.innerHeight } };',
      element,
    );
  let { box, viewport } = await drawn();
  const delta = scrollNeeded(box, viewport);
  if (delta !== 0) {
    const at = { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
    // Read only, for the failure message: how far the page had scrolled, and what sits under the wheel.
    const where = (): Promise<string> =>
      driver().execute(
        'const e = document.elementFromPoint(arguments[0], arguments[1]); return `page scrolled ${String(Math.round(window.scrollY))} px, under the scroll point <${e === null ? "nothing" : e.localName}>, focus on <${document.activeElement === null ? "nothing" : document.activeElement.localName}>`;',
        at.x,
        at.y,
      );
    const before = await where();
    const target = targetOf(driver().capabilities);
    if (target !== 'chromium' && target !== 'firefox' && target !== 'safari') throw new Error(`no desktop scroll input for ${target}`);
    const inView = async (): Promise<boolean> => {
      ({ box, viewport } = await drawn());
      return scrollNeeded(box, viewport) === 0;
    };
    try {
      if (scrollInput(target) === 'wheel') {
        // A real mouse-wheel scroll from the middle of the window, as a person brings a control into view.
        await driver().action('wheel').scroll({ x: at.x, y: at.y, deltaX: 0, deltaY: delta, duration: 200 }).perform();
        await driver().waitUntil(inView, { timeout: WAIT, timeoutMsg: `"${label}" stayed outside the window` });
      } else {
        // Real Page Down or Page Up presses, one at a time, until the control is in the window.
        let presses = 0;
        while (!(await inView())) {
          if (presses === PAGE_KEYS) throw new Error(`"${label}" stayed outside the window after ${String(PAGE_KEYS)} key presses`);
          await driver().keys([scrollKey(delta)]);
          presses += 1;
        }
      }
    } catch (error) {
      throw new Error(
        `"${label}" was still outside the window after scrolling ${String(delta)} px by ${scrollInput(target)} (before: ${before}; after: ${await where()})`,
        { cause: error },
      );
    }
  }
  // A scroll animates: press only once the control has stopped moving, inside the window.
  let last = box;
  await driver().waitUntil(
    async () => {
      ({ box, viewport } = await drawn());
      const still = sameBox(last, box);
      last = box;
      return still && scrollNeeded(box, viewport) === 0;
    },
    { timeout: WAIT, timeoutMsg: `"${label}" never stopped moving inside the window` },
  );
  await driver()
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move(viewportPoint(box, viewport, label))
    .down()
    .pause(50)
    .up()
    .perform();
}

/** A real click or touch on the control named `label`. */
export async function tap(label: string): Promise<void> {
  const on = phone();
  if (on === undefined) {
    await clickDrawn(label);
    return;
  }
  await native(() => nativeTap(on, nativeFinder(on, label), `the control named "${label}"`));
}

/**
 * A real touch where the page draws the element named `label`. Chrome on
 * Android gives text fields no native name, so the field's box is read from
 * the page and touched on screen, inside Chrome's page area.
 */
async function touchDrawn(label: string): Promise<void> {
  // Resolved, so the page script receives the DOM element, not WebdriverIO's handle.
  const element = await named(label);
  // Reads where the field is drawn; the input itself is the real touch below.
  const { box, ratio } = await driver().execute<{ box: Box; ratio: number }>(
    'const r = arguments[0].getBoundingClientRect(); return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, ratio: window.devicePixelRatio };',
    element,
  );
  await native(async () => {
    const page = driver().$(ANDROID_PAGE);
    await page.waitForExist({ timeout: WAIT, timeoutMsg: `android: Chrome's page area never appeared (${ANDROID_PAGE})` });
    const at = screenPoint(box, ratio, await page.getLocation());
    await driver()
      .action('pointer', { parameters: { pointerType: 'touch' } })
      .move(at)
      .down()
      .pause(50)
      .up()
      .perform();
  });
}

/** Real key presses into the field named `label`, after a real tap on it. */
export async function type(label: string, text: string): Promise<void> {
  const on = phone();
  if (on === 'ios') {
    // The page receives trusted focus, keydown and input from the on-screen keyboard.
    await native(async () => {
      await nativeTap(on, nativeFinder(on, label), `the field named "${label}"`);
      await driver().$(nativeFinder(on, label)).addValue(text);
    });
    return;
  }
  if (on === 'android') await touchDrawn(label);
  else await tap(label);
  // W3C key actions: trusted keydown and input per key, on desktop and Android alike.
  await driver().keys(Array.from(text));
}

const MEDIA = resolve(import.meta.dirname, '../../fixtures/media');

/** One test file chosen through the file input named `label`. */
export async function pickFile(label: string, fixture: Fixture): Promise<void> {
  const on = phone();
  if (on === undefined) {
    await (await named(label)).addValue(resolve(MEDIA, fixture));
    return;
  }
  await native(async () => {
    await nativeTap(on, nativeFinder(on, label), `the file input named "${label}"`);
    if (on === 'ios') {
      await nativeTap(on, nativeFinder(on, 'Photo Library'), 'the Photo Library choice');
      await nativeTap(on, nativeFinder(on, 'Collections'), 'the Collections tab');
      await nativeTap(on, nativeFinder(on, 'ShyDesk tests'), 'the "ShyDesk tests" album (AirDrop tests/fixtures/media into it)');
      await nativeTap(on, pickerItem(on, fixture), `${fixture} in the "ShyDesk tests" album`);
      // The picker keeps the choice open until it is confirmed (measured 2026-11-06).
      await nativeTap(on, "-ios predicate string:label == 'Done' AND type == 'XCUIElementTypeButton'", "the picker's Done button");
      return;
    }
    await nativeTap(on, nativeFinder(on, 'Collections'), 'the Collections tab');
    await nativeTap(on, "//*[@text='From this device']/ancestor::*[@clickable='true'][1]", 'the "From this device" collection');
    await nativeTap(
      on,
      "//*[@text='ShyDeskTests']/ancestor-or-self::*[@clickable='true'][1]",
      'the ShyDeskTests folder (adb push tests/fixtures/media to /sdcard/DCIM/ShyDeskTests)',
    );
    await nativeTap(on, pickerItem(on, fixture), `${fixture} in the ShyDeskTests folder`);
    // The picker allows several files, so the choice is confirmed.
    await nativeTap(on, 'android=new UiSelector().text("Done")', "the picker's Done button");
  });
}
