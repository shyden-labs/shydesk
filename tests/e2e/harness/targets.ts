/**
 * The targets the one end-to-end suite runs on, unchanged (shyden-labs/shydesk#42):
 * desktop Chromium, Firefox and Safari, and the real Android phone (Chrome)
 * and real iPhone (Safari) over USB through Appium. Set-up lives here and
 * only here; the tests themselves never name a target.
 */

export const TARGETS = ['chromium', 'firefox', 'safari', 'android', 'ios'] as const;
export type Target = (typeof TARGETS)[number];
export type Phone = 'android' | 'ios';

/** The suite's test files, picked from each phone's own photo library. */
export type Fixture = 'photo.jpg' | 'ok-10s.mp4' | 'long-45s.mp4';

export type Capabilities = Record<string, unknown>;

/** The targets named in `E2E_TARGETS`, comma-separated, in order. */
export function targetsFrom(list: string): Target[] {
  const names = list
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) throw new Error(`E2E_TARGETS names no target; known: ${TARGETS.join(', ')}`);
  const seen = new Set<string>();
  for (const name of names) {
    if (!(TARGETS as readonly string[]).includes(name)) throw new Error(`E2E_TARGETS names an unknown target: ${name}`);
    if (seen.has(name)) throw new Error(`E2E_TARGETS names ${name} twice`);
    seen.add(name);
  }
  return names as Target[];
}

export interface TargetEnv {
  chromedriver?: string;
  iosUdid?: string;
  androidSerial?: string;
}

/** The value, or an error naming the variable that should have held it. */
function need(value: string | undefined, message: string): string {
  if (value === undefined || value === '') throw new Error(message);
  return value;
}

/**
 * The WebDriver capabilities that start a session on `target`. Each phone is
 * named by its UDID or serial, so Appium never quietly picks a simulator or
 * emulator instead of the real device.
 */
export function capabilitiesFor(target: Target, env: TargetEnv): Capabilities {
  switch (target) {
    case 'chromium':
      return { browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new'] } };
    case 'firefox':
      return { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } };
    case 'safari':
      return { browserName: 'safari' };
    case 'ios':
      return {
        platformName: 'iOS',
        browserName: 'Safari',
        'appium:udid': need(env.iosUdid, "ios needs E2E_IOS_UDID: the real iPhone's UDID (xcrun xctrace list devices)"),
        'appium:automationName': 'XCUITest',
        // A tap on a page element is a real touch at its place on screen, not a script event.
        'appium:nativeWebTap': true,
        'appium:newCommandTimeout': 300,
      };
    case 'android':
      return {
        platformName: 'Android',
        browserName: 'Chrome',
        'appium:udid': need(env.androidSerial, "android needs E2E_ANDROID_SERIAL: the real phone's serial (adb devices)"),
        'appium:automationName': 'UiAutomator2',
        'appium:chromedriverExecutable': need(
          env.chromedriver,
          'android needs E2E_CHROMEDRIVER: the path to a chromedriver matching Chrome on the phone',
        ),
        // OxygenOS forbids adb from clearing Chrome's data, which Appium and
        // chromedriver each do by default.
        'appium:noReset': true,
        'goog:chromeOptions': { androidKeepAppDataDir: true },
        // BiDi cannot carry Android's native selectors into NATIVE_APP.
        'wdio:enforceWebDriverClassic': true,
        'appium:newCommandTimeout': 300,
      };
  }
}

/** The target a session's capabilities belong to. */
export function targetOf(capabilities: Capabilities): Target {
  const name = (key: string): string => {
    const value = capabilities[key];
    return typeof value === 'string' ? value.toLowerCase() : '';
  };
  const browser = name('browserName');
  const platform = name('platformName');
  if (platform === 'ios') return 'ios';
  if (platform === 'android') return 'android';
  if (browser === 'chrome') return 'chromium';
  if (browser === 'firefox' || browser === 'safari') return browser;
  throw new Error(`no target for capabilities ${JSON.stringify(capabilities)}`);
}

function plain(label: string): string {
  if (/["'\\]/.test(label)) throw new Error(`accessible name cannot hold quotes or backslashes: ${label}`);
  return label;
}

/** A selector for the control with this accessible name in the phone's native layer. */
export function nativeFinder(phone: Phone, label: string): string {
  return phone === 'android'
    ? // A description, or a tappable control's visible text: Chrome names a button by its text alone.
      `//*[starts-with(@content-desc, "${plain(label)}") or (@clickable="true" and @text="${plain(label)}")]`
    : // The photo picker shows an album as a button holding a text of the same name.
      `-ios predicate string:label == '${plain(label)}' AND type != 'XCUIElementTypeStaticText'`;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The screen point, in device pixels, at the middle of a page element: its CSS
 * box scaled by the page's pixel ratio, from where the page area starts on
 * screen. Chrome on Android gives text fields no native name, so they are
 * touched where they are drawn.
 */
export function screenPoint(box: Box, ratio: number, page: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(page.x + (box.x + box.width / 2) * ratio),
    y: Math.round(page.y + (box.y + box.height / 2) * ratio),
  };
}

/** Chrome's page area in the Android native tree. */
export const ANDROID_PAGE = '//android.webkit.WebView';

const SECONDS: Record<Exclude<Fixture, 'photo.jpg'>, string> = { 'ok-10s.mp4': '10', 'long-45s.mp4': '45' };
/** How the iPhone picker speaks each length. */
const SPOKEN: Record<Exclude<Fixture, 'photo.jpg'>, string> = { 'ok-10s.mp4': 'ten', 'long-45s.mp4': 'forty-five' };
/** Only the items themselves: the grid around them is labelled with every item. */
const IOS_ITEM = "-ios predicate string:type == 'XCUIElementTypeImage' AND";

/** A selector for one test file in the phone's own photo picker, by its kind and length. */
export function pickerItem(phone: Phone, fixture: Fixture): string {
  if (phone === 'android')
    return fixture === 'photo.jpg'
      ? 'android=new UiSelector().descriptionStartsWith("Photo taken")'
      : `android=new UiSelector().descriptionContains("with duration 00:${SECONDS[fixture]}")`;
  return fixture === 'photo.jpg'
    ? `${IOS_ITEM} label BEGINSWITH 'Photo,'`
    : `${IOS_ITEM} label BEGINSWITH 'Video, ${SPOKEN[fixture]} seconds,'`;
}

/**
 * The viewport point, in CSS pixels, at the middle of a page element's box.
 * A desktop click goes there as a real mouse press: Safari's Element Click
 * cannot reach inside a shadow root (WebKit bug 202589; measured on PR
 * shyden-labs/shydesk#69, "click intercepted"), and the support piece draws
 * its form in one. Fails naming the element when it is not drawn in the window.
 */
export function viewportPoint(box: Box, viewport: { width: number; height: number }, label: string): { x: number; y: number } {
  if (box.width <= 0 || box.height <= 0) throw new Error(`"${label}" is not drawn (it has no size)`);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    throw new Error(
      `"${label}" is drawn outside the window (its middle is at ${String(x)}, ${String(y)} in a ${String(viewport.width)} by ${String(viewport.height)} window)`,
    );
  }
  return { x, y };
}

/**
 * Why a lookup by name failed: the name wanted, every distinct name the page
 * did have, and the error the last lookup threw, if it threw one.
 */
export function notNamedMessage(label: string, seen: readonly string[], failure?: string): string {
  const missing = `no element named "${label}" appeared on the page`;
  const names =
    seen.length === 0
      ? `${missing}; it had no named elements at all`
      : `${missing}; the names seen were: ${[...new Set(seen)].map((name) => `"${name}"`).join(', ')}`;
  return failure === undefined ? names : `${names}; the last lookup failed: ${failure}`;
}

/**
 * Why the field named `label` does not hold `typed` after it was typed in, or
 * undefined when it does. Safari lost key presses on run 42440108844
 * (shyden-labs/shydesk#71): "The app will not open" arrived as "The apwilnotopen".
 */
export function typedMismatch(label: string, typed: string, held: string): string | undefined {
  if (held === typed) return undefined;
  return `"${label}" held "${held}" after typing "${typed}"; the browser lost or changed key presses`;
}

/** Where a real press reached the page: its point, the element it landed on, and whether that is the control or inside it. */
export interface Landed {
  x: number;
  y: number;
  on: string;
  inside: boolean;
  /** Where the control was drawn at the moment of the press. */
  control: { x: number; y: number; width: number; height: number };
  /** How far the page had scrolled when the press was aimed, and when it landed. */
  aimedScroll: number;
  pressedScroll: number;
}

/**
 * Why a press aimed at `at` on the control named `label` did not reach it, or
 * undefined when it did. On Safari a press on "Send" left the form unsent
 * (runs 42440108844 and 42448093505, shyden-labs/shydesk#71), so every press
 * says where it actually landed.
 */
export function pressMissed(label: string, at: { x: number; y: number }, landed: Landed | null): string | undefined {
  const aimed = `the press on "${label}" at ${String(at.x)}, ${String(at.y)}`;
  if (landed === null) return `${aimed} never reached the page`;
  if (landed.inside) return undefined;
  const c = landed.control;
  return (
    `${aimed} landed on <${landed.on}> at ${String(landed.x)}, ${String(landed.y)} instead; ` +
    `"${label}" was then drawn at ${String(Math.round(c.x))}, ${String(Math.round(c.y))} (${String(Math.round(c.width))} x ${String(Math.round(c.height))}), ` +
    `page scrolled ${String(landed.aimedScroll)} px when aimed and ${String(landed.pressedScroll)} px when pressed`
  );
}

/** A W3C key action sequence being built: each step presses or lifts one key. */
export interface KeySequence {
  down(key: string): KeySequence;
  up(key: string): KeySequence;
}

/**
 * Adds `text` to `sequence` as a person types it: each key pressed and lifted
 * before the next. WebdriverIO's `keys` presses every key down before lifting
 * any, so a key already held (a repeated letter, every space after the first)
 * gave Safari no new key press: "The app will not open" arrived as
 * "The apwilnotopen" (runs 42440108844 and 42441734182, shyden-labs/shydesk#71).
 */
export function typed<T extends KeySequence>(sequence: T, text: string): T {
  for (const key of Array.from(text)) sequence.down(key).up(key);
  return sequence;
}

/**
 * Whether a control's accessible name is `label`. A file input's name also
 * carries the browser's own button text after the label on some targets
 * (Firefox: "Harness file Browse… No file selected.", measured on PR
 * shyden-labs/shydesk#69), so a file input matches the label followed by a space.
 */
export function nameMatches(label: string, name: string, fileInput: boolean): boolean {
  return name === label || (fileInput && name.startsWith(`${label} `));
}

/**
 * How far, in CSS pixels, the page must scroll (down is positive) to bring the
 * middle of an element to the middle of the window; 0 when its middle is
 * already in the window. The scroll itself is a real wheel action.
 */
export function scrollNeeded(box: Box, viewport: { width: number; height: number }): number {
  const middle = box.y + box.height / 2;
  if (middle >= 0 && middle < viewport.height) return 0;
  return Math.round(middle - viewport.height / 2);
}

/**
 * The real input that scrolls the page on each desktop target. Safari's driver
 * accepts a W3C wheel action but scrolls nothing (measured on PR
 * shyden-labs/shydesk#69, run 42408345149: 0 px after a 401 px wheel), so
 * Safari scrolls the way a keyboard user does, by Page Down and Page Up.
 */
export function scrollInput(target: 'chromium' | 'firefox' | 'safari'): 'wheel' | 'keys' {
  return target === 'safari' ? 'keys' : 'wheel';
}

/** The WebDriver key that scrolls toward a control `delta` px away (down is positive): Page Down or Page Up. */
export function scrollKey(delta: number): string {
  return delta > 0 ? '' : '';
}

/**
 * Whether a control is drawn in the same place and size in two reads. A
 * scroll animates, so a control is pressed only once it has stopped moving,
 * never where it was partway through the scroll.
 */
export function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * iOS Safari answers WebDriver's Get Computed Label with "Method has not yet
 * been implemented" (shyden-labs/shydesk#73), so on the iPhone the name is
 * the one iOS gives the control in its native accessibility tree, the name
 * VoiceOver reads. iOS appends a role after a comma to some names ("Support
 * status, application status" for a live region). Text drawn on the page is
 * left out, as a label's text has the same name as its field.
 */
export function iosNamed(label: string): string {
  const name = plain(label);
  return `-ios predicate string:(label == '${name}' OR label BEGINSWITH '${name}, ') AND type != 'XCUIElementTypeStaticText'`;
}

/** The page's own area in the iPhone's native tree, which iOS names after the document title. */
export function iosPage(title: string): string {
  return `-ios predicate string:label == '${plain(title)}' AND type == 'XCUIElementTypeOther'`;
}

/** The biggest box: the page area, over a heading that shares the title (measured 2026-11-08). */
export function largest(boxes: readonly Box[]): Box | undefined {
  let found: Box | undefined;
  for (const box of boxes) if (found === undefined || box.width * box.height > found.width * found.height) found = box;
  return found;
}

/**
 * Where a native box sits in the document, in CSS pixels: measured from the
 * page area's corner, which moves up as the page scrolls, and scaled by CSS
 * pixels per native point (1 unless the page is zoomed).
 */
export function inDocument(native: Box, page: Box, scale: number): Box {
  return {
    x: (native.x - page.x) * scale,
    y: (native.y - page.y) * scale,
    width: native.width * scale,
    height: native.height * scale,
  };
}

/**
 * Whether two boxes are the same control: each one's middle lies inside the
 * other. iOS rounds native boxes to whole points and draws a focused field a
 * point bigger on each side, so edges never quite agree; a neighbour, the form
 * around a field, or a field inside a box fails one of the two checks.
 */
export function drawnAt(a: Box, b: Box): boolean {
  return centreInside(a, b) && centreInside(b, a);
}

/** How long a control must stay in one place before it counts as stopped moving. */
export const STEADY_MS = 300;

/** A control's last drawn box and when it was first drawn there. */
export interface Steady {
  box: Box;
  since: number;
}

/**
 * The control's steadiness after a new read at `now`. Two reads taken one
 * after the other can fall in the same frame of a scroll and match while the
 * page is still moving: Safari's press on Send was aimed at a page scrolled
 * 69 px and landed at 164 px (run 42457748277, shyden-labs/shydesk#71). So a
 * control counts as still only once it has stayed put for STEADY_MS.
 */
export function steadyFrom(previous: Steady | undefined, box: Box, now: number): Steady {
  return previous !== undefined && sameBox(previous.box, box) ? previous : { box, since: now };
}

/** Whether the control has stayed in one place for at least STEADY_MS by `now`. */
export function steadyLongEnough(steady: Steady, now: number): boolean {
  return now - steady.since >= STEADY_MS;
}

/**
 * A real finger swipe up the middle of the page area, from 70% to 30% of its
 * height, which scrolls the page down by about 40% of that area. A phone's
 * native tree leaves out controls drawn below the screen, so a control that is
 * not there yet is brought onto it this way, as a person would. The area is
 * Chrome's page view, which ends above the on-screen keyboard: a swipe that
 * starts on the keyboard scrolls nothing (measured on the OnePlus, 2026-11-08).
 */
export function swipeUp(area: Box): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const x = Math.round(area.x + area.width / 2);
  return { from: { x, y: Math.round(area.y + area.height * 0.7) }, to: { x, y: Math.round(area.y + area.height * 0.3) } };
}

/**
 * Whether the middle of a control lies inside an area, such as Chrome's page
 * view above the on-screen keyboard. A phone's native tree also lists controls
 * hidden under the keyboard, and a touch there hits the keyboard instead.
 */
export function centreInside(box: Box, area: Box): boolean {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
}
