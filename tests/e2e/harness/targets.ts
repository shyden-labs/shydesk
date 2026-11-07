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
    ? `android=new UiSelector().descriptionStartsWith("${plain(label)}")`
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

/** Why a lookup by name failed: the name wanted, and every distinct name the page did have. */
export function notNamedMessage(label: string, seen: readonly string[]): string {
  const missing = `no element named "${label}" appeared on the page`;
  if (seen.length === 0) return `${missing}; it had no named elements at all`;
  return `${missing}; the names seen were: ${[...new Set(seen)].map((name) => `"${name}"`).join(', ')}`;
}
