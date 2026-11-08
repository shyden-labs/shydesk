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
import { copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { driver } from './driver.ts';
import { named } from './find.ts';
import { resolve } from 'node:path';
import {
  ANDROID_PAGE,
  nativeFinder,
  pickerItem,
  screenPoint,
  targetOf,
  steadyFrom,
  steadyLongEnough,
  type Steady,
  scrollInput,
  scrollKey,
  scrollNeeded,
  swipeUp,
  centreInside,
  viewportPoint,
  type Box,
  type Fixture,
  type Phone,
  typedMismatch,
  typed,
  pressMissed,
  type Landed,
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
  let steady: Steady | undefined;
  await driver().waitUntil(
    async () => {
      ({ box, viewport } = await drawn());
      steady = steadyFrom(steady, box, Date.now());
      return steadyLongEnough(steady, Date.now()) && scrollNeeded(box, viewport) === 0;
    },
    { timeout: WAIT, timeoutMsg: `"${label}" never stopped moving inside the window` },
  );
  const at = viewportPoint(box, viewport, label);
  // Read only: notes where the next real press lands, so a press that misses the control fails naming where it went.
  await driver().execute(
    'const control = arguments[0]; const aimedScroll = Math.round(window.scrollY); window.__e2ePress = null; document.addEventListener("pointerdown", (e) => { const path = e.composedPath(); const hit = path[0]; const r = control.getBoundingClientRect(); window.__e2ePress = { x: Math.round(e.clientX), y: Math.round(e.clientY), on: hit instanceof Element ? hit.localName : String(hit), inside: path.includes(control), control: { x: r.x, y: r.y, width: r.width, height: r.height }, aimedScroll, pressedScroll: Math.round(window.scrollY) }; }, { capture: true, once: true });',
    element,
  );
  await driver()
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move(at)
    .down()
    .pause(50)
    .up()
    .perform();
  const missed = pressMissed(label, at, await driver().execute<Landed | null>('return window.__e2ePress;'));
  if (missed !== undefined) throw new Error(missed);
}

/** Real finger swipes allowed to bring a page control onto a phone screen: more than any test page is long. */
const SWIPES = 8;

/** Android's Back key code, which closes the on-screen keyboard. */
const ANDROID_BACK = 4;

/** The Done button on the bar iOS shows above the on-screen keyboard; it closes the keyboard. */
const IOS_KEYBOARD_DONE = "-ios class chain:**/XCUIElementTypeToolbar/**/XCUIElementTypeButton[`label == 'Done'`]";

/**
 * A real touch on a page control in the phone's native layer. The native tree
 * leaves out controls drawn below the screen ("Send" never appeared on the
 * OnePlus, 2026-11-08) and also lists controls hidden under the on-screen
 * keyboard (Send at y 2820, below a page view ending at 1887). So once the
 * control is in the page, real finger swipes bring it inside the page view,
 * one at a time, and the touch fails naming how many.
 */
async function nativePageTap(on: 'android', label: string, what: string): Promise<void> {
  const selector = nativeFinder(on, label);
  const element = driver().$(selector);
  // The native tree also lists controls under the keyboard, so a control must be inside the page view.
  const onScreen = async (): Promise<boolean> =>
    (await element.isExisting()) && centreInside({ ...(await element.getLocation()), ...(await element.getSize()) }, await pageView());
  let swipes = 0;
  while (!(await onScreen())) {
    if (swipes === SWIPES) {
      throw new Error(`${on}: ${what} was not inside the page view after ${String(SWIPES)} swipes up the page (${selector})`);
    }
    await swipePage(await pageView());
    swipes += 1;
  }
  await element.click();
}

/** A real click or touch on the control named `label`. */
export async function tap(label: string): Promise<void> {
  const on = phone();
  if (on === undefined) {
    await clickDrawn(label);
    return;
  }
  if (on === 'android') {
    // In the page first, so a form still drawing is waited for, never swiped past.
    await named(label);
    await native(() => nativePageTap(on, label, `the control named "${label}"`));
    return;
  }
  await native(async () => {
    // The keyboard and the bar above it cover the lower page, so a person closes it before tapping a
    // control there: Send sat on the keyboard's top edge and the touch never reached it (shyden-labs/shydesk#73).
    const done = driver().$(IOS_KEYBOARD_DONE);
    if (await done.isExisting()) await done.click();
    await nativeTap(on, nativeFinder(on, label), `the control named "${label}"`);
  });
}

/** A real finger swipe up Chrome's page view, which scrolls the page down. */
async function swipePage(area: Box): Promise<void> {
  const { from, to } = swipeUp(area);
  await driver()
    .action('pointer', { parameters: { pointerType: 'touch' } })
    .move(from)
    .down()
    .move({ ...to, duration: 400 })
    // Held still before lifting, so the page stops where the finger does instead of flicking on.
    .pause(300)
    .up()
    .perform();
}

/** Chrome's page view in the native layer: the part of the screen showing the page, above the keyboard when it is up. */
async function pageView(): Promise<Box> {
  const page = driver().$(ANDROID_PAGE);
  await page.waitForExist({ timeout: WAIT, timeoutMsg: `android: Chrome's page area never appeared (${ANDROID_PAGE})` });
  return { ...(await page.getLocation()), ...(await page.getSize()) };
}

/**
 * A real touch where the page draws the element named `label`. Chrome on
 * Android gives text fields no native name, so the field's box is read from
 * the page and touched on screen, inside Chrome's page view. A field drawn
 * under the on-screen keyboard is first swiped up into the page view: a touch
 * there hit the keyboard instead, typing "6" and "v" into the field above
 * (measured on the OnePlus, 2026-11-08).
 */
async function touchDrawn(label: string): Promise<void> {
  // Resolved, so the page script receives the DOM element, not WebdriverIO's handle.
  const element = await named(label);
  // The keyboard from the last field resizes the page view as it comes and goes, moving the
  // page between a read and a touch; it is closed first with the Back key, as a person would.
  await native(async () => {
    if (!(await driver().isKeyboardShown())) return;
    await driver().pressKeyCode(ANDROID_BACK);
    await driver().waitUntil(async () => !(await driver().isKeyboardShown()), {
      timeout: WAIT,
      timeoutMsg: 'android: the on-screen keyboard stayed open after the Back key',
    });
  });
  for (let swipes = 0; swipes <= SWIPES; swipes += 1) {
    // Reads where the field is drawn, until two reads agree, so a page still moving is never touched.
    const drawn = (): Promise<{ box: Box; ratio: number }> =>
      driver().execute(
        'const r = arguments[0].getBoundingClientRect(); return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, ratio: window.devicePixelRatio };',
        element,
      );
    let { box, ratio } = await drawn();
    let steady: Steady | undefined;
    await driver().waitUntil(
      async () => {
        ({ box, ratio } = await drawn());
        steady = steadyFrom(steady, box, Date.now());
        return steadyLongEnough(steady, Date.now());
      },
      { timeout: WAIT, timeoutMsg: `android: the field named "${label}" never stopped moving` },
    );
    const touched = await native(async () => {
      const area = await pageView();
      const at = screenPoint(box, ratio, area);
      // A point is a box with no size, whose middle is the point itself.
      if (!centreInside({ ...at, width: 0, height: 0 }, area)) {
        if (swipes < SWIPES) await swipePage(area);
        return false;
      }
      await driver()
        .action('pointer', { parameters: { pointerType: 'touch' } })
        .move(at)
        .down()
        .pause(50)
        .up()
        .perform();
      return true;
    });
    if (touched) return;
  }
  throw new Error(`android: the field named "${label}" was not inside the page view after ${String(SWIPES)} swipes up the page`);
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
  } else {
    if (on === 'android') await touchDrawn(label);
    else await tap(label);
    // W3C key actions, each key pressed and lifted in turn: trusted keydown and input per key, on desktop and Android alike.
    await typed(driver().action('key'), text).perform();
  }
  // Every target: the field holds exactly the text typed, or the test fails naming what it held.
  const mismatch = typedMismatch(label, text, String(await (await named(label)).getProperty('value')));
  if (mismatch !== undefined) throw new Error(mismatch);
}

const MEDIA = resolve(import.meta.dirname, '../../fixtures/media');

/** One test file chosen through the file input named `label`. */
/** TEMPORARY experiment (shyden-labs/shydesk#21): does Safari read a driver-supplied file from another folder? */
function desktopPath(fixture: Fixture): string {
  if (targetOf(driver().capabilities) !== 'safari') return resolve(MEDIA, fixture);
  const folder = fixture === 'photo.jpg' ? join(homedir(), 'Downloads') : '/tmp';
  const path = join(folder, fixture);
  copyFileSync(resolve(MEDIA, fixture), path);
  return path;
}

export async function pickFile(label: string, fixture: Fixture): Promise<void> {
  const on = phone();
  if (on === undefined) {
    await (await named(label)).addValue(desktopPath(fixture));
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
