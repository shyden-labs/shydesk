/**
 * Real input on each phone (shyden-labs/shydesk#42 AC4). Tests call these and
 * never a driver directly, so one test runs unchanged on every phone. Desktop
 * browsers run the same journeys on Playwright, through tests/e2e-pw/harness/
 * (shyden-labs/shydesk#176).
 *
 * Appium's native layer, measured 2026-11-05/06 on the real phones, gives a
 * real touch on the control, real key presses (on the iPhone, the viewer's
 * keys are its own controls: shyden-labs/shydesk#99), and the phone's own photo
 * picker opening the "ShyDesk tests" album (iPhone) or the ShyDeskTests
 * folder (Android) that holds only the test files.
 *
 * Controls are found by their accessible name, the same on every phone. A
 * step that cannot happen fails naming what was missing.
 */
import { driver } from './driver.ts';
import { named } from './find.ts';
import {
  ANDROID_COORDINATOR,
  androidPageArea,
  nativeFinder,
  pickerItem,
  screenPoint,
  targetOf,
  steadyFrom,
  steadyLongEnough,
  type Steady,
  swipeUp,
  centreInside,
  videoControlPoint,
  type VideoControl,
  type Box,
  ANDROID_KEYS,
  IOS_KEY_CONTROLS,
  iosPageOrigin,
  pinchOut,
  fingerSwipeLeft,
  type Fixture,
  type Phone,
  typedMismatch,
  typed,
  coverOver,
  type Cover,
} from './targets.ts';

const WAIT = 15_000;

/** The phone this session drives. */
function phone(): Phone {
  return targetOf(driver().capabilities);
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
 * A real press on a link or a button that loads a new page, waiting until that
 * page is ready: asking Firefox about an element while its page is being replaced
 * hangs for good (run 42543992055).
 */
export async function tapToNewPage(label: string): Promise<void> {
  await driver().execute('window.__e2eLeaving = true;');
  await tap(label);
  await driver().waitUntil(
    async () => driver().execute<boolean>("return window.__e2eLeaving === undefined && document.readyState === 'complete';"),
    { timeout: WAIT, timeoutMsg: `the press on "${label}" never loaded a new page` },
  );
}

/** Real finger swipes allowed to bring a page control onto a phone screen: more than any test page is long. */
const SWIPES = 8;

/** Android's Back key code, which closes the on-screen keyboard. */
const ANDROID_BACK = 4;

/** The Done button on the bar iOS shows above the on-screen keyboard; it closes the keyboard. */
const IOS_KEYBOARD_DONE = "-ios class chain:**/XCUIElementTypeToolbar/**/XCUIElementTypeButton[`label == 'Done'`]";

/** What iOS draws over the lower page while a field is focused: the bar above the keyboard, and the keyboard. */
const IOS_COVERS = [
  { name: 'the keyboard bar', selector: '-ios class chain:**/XCUIElementTypeToolbar' },
  { name: 'the on-screen keyboard', selector: '-ios class chain:**/XCUIElementTypeKeyboard' },
] as const;

/** iOS: where the keyboard bar and the keyboard are drawn, for those showing now. */
async function iosCovers(): Promise<Cover[]> {
  const covers: Cover[] = [];
  for (const { name, selector } of IOS_COVERS) {
    const cover = driver().$(selector);
    if (await cover.isExisting()) covers.push({ name, box: { ...(await cover.getLocation()), ...(await cover.getSize()) } });
  }
  return covers;
}

/**
 * iOS: a real tap on the element `selector` finds, with the keyboard closed
 * first by a tap on its bar's Done button, as a person would. The keyboard and
 * its bar cover the lower page: Send sat on the keyboard's top edge
 * (shyden-labs/shydesk#73), and the bar over the top of the reply's "Choose
 * Files" control kept the picker from opening (shyden-labs/shydesk#149). If
 * anything still lies over the element, the test fails naming it.
 */
async function iosTapClear(selector: string, what: string): Promise<void> {
  const element = driver().$(selector);
  await element.waitForExist({ timeout: WAIT, timeoutMsg: `ios: ${what} never appeared (${selector})` });
  const box = async (): Promise<Box> => ({ ...(await element.getLocation()), ...(await element.getSize()) });
  // Read only, printed on every run: what the keyboard covered before it closed (shyden-labs/shydesk#149 AC1).
  console.log(`ios: before the keyboard closed, ${coverOver(what, await box(), await iosCovers()) ?? `nothing lay over ${what}`}`);
  const done = driver().$(IOS_KEYBOARD_DONE);
  if (await done.isExisting()) {
    await done.click();
    await driver().waitUntil(async () => !(await driver().$(IOS_COVERS[1].selector).isExisting()), {
      timeout: WAIT,
      timeoutMsg: "ios: the on-screen keyboard stayed open after its bar's Done button",
    });
  }
  const covered = coverOver(what, await box(), await iosCovers());
  if (covered !== undefined) throw new Error(covered);
  await element.click();
}

/** A real touch on the control named `label`. */
export async function tap(label: string): Promise<void> {
  const on = phone();
  if (on === 'android') {
    await touchDrawn(label);
    return;
  }
  await native(() => iosTapClear(nativeFinder(on, label), `the control named "${label}"`));
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

/**
 * Chrome's page view in the native layer: the part of the screen showing the page, found from Chrome's
 * coordinator view and the page's own window, since Chrome's WebView node comes and goes from the native
 * tree (shyden-labs/shydesk#99). The on-screen keyboard is closed before it is read.
 */
async function pageView(innerHeight: number, ratio: number): Promise<Box> {
  const coordinator = driver().$(ANDROID_COORDINATOR);
  await coordinator.waitForExist({
    timeout: WAIT,
    timeoutMsg: `android: Chrome's coordinator view never appeared (${ANDROID_COORDINATOR})`,
  });
  return androidPageArea({ ...(await coordinator.getLocation()), ...(await coordinator.getSize()) }, innerHeight, ratio);
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
    const drawn = (): Promise<{ box: Box; ratio: number; innerHeight: number }> =>
      driver().execute(
        'const r = arguments[0].getBoundingClientRect(); return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, ratio: window.devicePixelRatio, innerHeight: window.innerHeight };',
        element,
      );
    let { box, ratio, innerHeight } = await drawn();
    let steady: Steady | undefined;
    await driver().waitUntil(
      async () => {
        ({ box, ratio, innerHeight } = await drawn());
        steady = steadyFrom(steady, box, Date.now());
        return steadyLongEnough(steady, Date.now());
      },
      { timeout: WAIT, timeoutMsg: `android: the field named "${label}" never stopped moving` },
    );
    const touched = await native(async () => {
      const area = await pageView(innerHeight, ratio);
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
  // Typing adds to what the field holds, such as a canned reply being edited.
  const before = String(await (await named(label)).getProperty('value'));
  if (on === 'ios') {
    // A field that already holds the caret, as a canned reply leaves it at its end, is typed into as it
    // is: a tap on it would move the caret, to the start (measured 2026-11-15, shyden-labs/shydesk#99).
    const focused = await driver().execute<boolean>(
      'const f = arguments[0]; return f.getRootNode().activeElement === f;',
      await named(label),
    );
    // The page receives trusted focus, keydown and input from the on-screen keyboard.
    await native(async () => {
      if (!focused) await nativeTap(on, nativeFinder(on, label), `the field named "${label}"`);
      await driver().$(nativeFinder(on, label)).addValue(text);
    });
  } else {
    await touchDrawn(label);
    // W3C key actions, each key pressed and lifted in turn: trusted keydown and input per key.
    await typed(driver().action('key'), text).perform();
  }
  // Every phone: the field holds exactly what it held plus the text typed, or the test fails naming what it held.
  const mismatch = typedMismatch(label, before + text, String(await (await named(label)).getProperty('value')));
  if (mismatch !== undefined) throw new Error(mismatch);
}

/** One test file chosen through the file input named `label`, from the phone's own picker. */
export async function pickFile(label: string, fixture: Fixture): Promise<void> {
  const on = phone();
  // On Android the input is touched where the page draws it: Chrome's WebView node, and the input's
  // native name with it, comes and goes from the native tree (shyden-labs/shydesk#99).
  if (on === 'android') await touchDrawn(label);
  await native(async () => {
    if (on === 'ios') {
      await iosTapClear(nativeFinder(on, label), `the file input named "${label}"`);
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

/** The keys the viewer answers to (shyden-labs/shydesk#25). */
export type ViewerKey = keyof typeof ANDROID_KEYS;

const PAGE_RECT = 'const r = arguments[0].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };';

/**
 * Where on the iPhone screen the middle of the element named `label` is drawn, in points. The page's
 * origin is read from the viewer's "Close viewer" control, which the viewer always draws, as every
 * iPhone gesture here is made in the viewer (shyden-labs/shydesk#99).
 */
async function onIosScreen(label: string): Promise<{ x: number; y: number }> {
  const reference = IOS_KEY_CONTROLS.Escape;
  const box = await driver().execute<Box>(PAGE_RECT, await named(label));
  const page = await driver().execute<Box>(PAGE_RECT, await named(reference));
  const screen = await native(async (): Promise<Box> => {
    const selector = nativeFinder('ios', reference);
    const control = driver().$(selector);
    await control.waitForExist({ timeout: WAIT, timeoutMsg: `ios: the control named "${reference}" never appeared (${selector})` });
    return { ...(await control.getLocation()), ...(await control.getSize()) };
  });
  return screenPoint(box, 1, iosPageOrigin(screen, page, reference));
}

/** Where on the Android screen the middle of the element named `label` is drawn, and the screen px per CSS px. */
async function onAndroidScreen(label: string): Promise<{ at: { x: number; y: number }; ratio: number }> {
  const element = await named(label);
  const { box, ratio, innerHeight } = await driver().execute<{ box: Box; ratio: number; innerHeight: number }>(
    'const r = arguments[0].getBoundingClientRect(); return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, ratio: window.devicePixelRatio, innerHeight: window.innerHeight };',
    element,
  );
  const area = await native(() => pageView(innerHeight, ratio));
  return { at: screenPoint(box, ratio, area), ratio };
}

/** One real finger: down at `from`, along to `to` over `duration` ms, then up. */
function finger(id: string, from: { x: number; y: number }, to: { x: number; y: number }, duration: number) {
  return driver()
    .action('pointer', { id, parameters: { pointerType: 'touch' } })
    .move(from)
    .down()
    .move({ ...to, duration })
    .up();
}

/** Where on screen the middle of the element named `label` is drawn on this phone, and the screen px per CSS px. */
async function onScreen(label: string): Promise<{ at: { x: number; y: number }; ratio: number }> {
  return phone() === 'android' ? onAndroidScreen(label) : { at: await onIosScreen(label), ratio: 1 };
}

/** A real two-finger pinch out over the element named `label`. */
export async function zoomIn(label: string): Promise<void> {
  const { at, ratio } = await onScreen(label);
  const [one, two] = pinchOut(at, ratio);
  await native(() => driver().actions([finger('one', one.from, one.to, 400), finger('two', two.from, two.to, 400)]));
}

/** A real finger swipe across the element named `label`, right to left. */
export async function swipeLeft(label: string): Promise<void> {
  const { at, ratio } = await onScreen(label);
  const path = fingerSwipeLeft(at, ratio);
  await native(() => finger('one', path.from, path.to, 300).perform());
}

/**
 * A real finger tap at the middle of where the element named `label` is drawn. Whatever a person's
 * press there would reach gets it, as a layer drawn over the element does (shyden-labs/shydesk#108).
 */
export async function clickMiddleOf(label: string): Promise<void> {
  const { at } = await onScreen(label);
  await native(() => finger('one', at, at, 0).perform());
}

/**
 * A real mouse press on the browser's own `control` over the video named `label` (shyden-labs/shydesk#108
 * AC2). The pointer rests there first, so a browser that hides its controls while playing shows them.
 * Phones fail naming the ticket that measures their controls (shyden-labs/shydesk#176).
 */
export async function pressVideoControl(label: string, control: VideoControl): Promise<void> {
  const video = await named(label);
  const box = await driver().execute<Box>(PAGE_RECT, video);
  const at = videoControlPoint(box, control, targetOf(driver().capabilities));
  await driver()
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: at.x, y: at.y })
    .pause(500)
    .down()
    .up()
    .perform();
}

/**
 * A real key press, sent to whatever has focus: Android's own key event on that phone. On the iPhone a
 * key reaches the page only while a text field holds focus, so the viewer's key is pressed as its own
 * on-screen control, a real tap (measured 2026-11-14, shyden-labs/shydesk#99).
 */
export async function press(key: ViewerKey): Promise<void> {
  const on = phone();
  if (on === 'ios') {
    await tap(IOS_KEY_CONTROLS[key]);
    return;
  }
  await native(() => driver().pressKeyCode(ANDROID_KEYS[key]));
}
