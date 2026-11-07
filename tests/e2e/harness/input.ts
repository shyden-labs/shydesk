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
import { ANDROID_PAGE, nativeFinder, pickerItem, screenPoint, targetOf, type Box, type Fixture, type Phone } from './targets.ts';

const WAIT = 15_000;

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

/** A real click or touch on the control named `label`. */
export async function tap(label: string): Promise<void> {
  const on = phone();
  if (on === undefined) {
    await (await named(label)).click();
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
