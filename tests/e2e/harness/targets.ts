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

/** The WebDriver capabilities that start a session on `target`. */
export function capabilitiesFor(target: Target, env: { chromedriver?: string }): Capabilities {
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
        'appium:automationName': 'XCUITest',
        // A tap on a page element is a real touch at its place on screen, not a script event.
        'appium:nativeWebTap': true,
        'appium:newCommandTimeout': 300,
      };
    case 'android':
      if (env.chromedriver === undefined || env.chromedriver === '')
        throw new Error('android needs E2E_CHROMEDRIVER: the path to a chromedriver matching Chrome on the phone');
      return {
        platformName: 'Android',
        browserName: 'Chrome',
        'appium:automationName': 'UiAutomator2',
        'appium:chromedriverExecutable': env.chromedriver,
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
    : `-ios predicate string:label == '${plain(label)}'`;
}

const SECONDS: Record<Exclude<Fixture, 'photo.jpg'>, string> = { 'ok-10s.mp4': '10', 'long-45s.mp4': '45' };

/** A selector for one test file in the phone's own photo picker, by its kind and length. */
export function pickerItem(phone: Phone, fixture: Fixture): string {
  if (phone === 'android')
    return fixture === 'photo.jpg'
      ? 'android=new UiSelector().descriptionStartsWith("Photo taken")'
      : `android=new UiSelector().descriptionContains("with duration 00:${SECONDS[fixture]}")`;
  return fixture === 'photo.jpg'
    ? "-ios predicate string:label BEGINSWITH 'Photo'"
    : `-ios predicate string:label BEGINSWITH 'Video' AND label CONTAINS '${SECONDS[fixture]} seconds'`;
}
