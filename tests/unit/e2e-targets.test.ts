import { describe, it, expect } from 'vitest';
import { capabilitiesFor, nativeFinder, pickerItem, targetOf, TARGETS, targetsFrom } from '../e2e/harness/targets.ts';

/**
 * The every-target suite's targets (shyden-labs/shydesk#42 AC1): set-up is the
 * only per-target code, so these pin which session belongs to which target and
 * how each phone finds a control and a test file in its own photo picker.
 */

describe('targetsFrom', () => {
  it('reads a comma-separated list of known targets, in order', () => {
    expect(targetsFrom('safari,chromium')).toEqual(['safari', 'chromium']);
  });

  it('refuses an empty list, naming the known targets', () => {
    expect(() => targetsFrom('')).toThrow(`E2E_TARGETS names no target; known: ${TARGETS.join(', ')}`);
  });

  it('refuses an unknown target by name', () => {
    expect(() => targetsFrom('chromium,edge')).toThrow('E2E_TARGETS names an unknown target: edge');
  });

  it('refuses a target named twice', () => {
    expect(() => targetsFrom('ios,ios')).toThrow('E2E_TARGETS names ios twice');
  });
});

const PHONES = { chromedriver: '/cd', iosUdid: '0000-IPHONE', androidSerial: 'SERIAL1' };

describe('capabilitiesFor and targetOf agree', () => {
  it.each(TARGETS.map((target) => [target]))('%s', (target) => {
    expect(targetOf(capabilitiesFor(target, PHONES))).toBe(target);
  });
});

describe('capabilitiesFor', () => {
  it('runs desktop Chrome and Firefox headless', () => {
    expect(capabilitiesFor('chromium', {})).toEqual({
      browserName: 'chrome',
      'goog:chromeOptions': { args: ['--headless=new'] },
    });
    expect(capabilitiesFor('firefox', {})).toEqual({ browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } });
  });

  it('drives the real iPhone through Appium with real touches in the page', () => {
    expect(capabilitiesFor('ios', PHONES)).toMatchObject({
      'appium:udid': '0000-IPHONE',
      platformName: 'iOS',
      browserName: 'Safari',
      'appium:automationName': 'XCUITest',
      'appium:nativeWebTap': true,
    });
  });

  it('drives Chrome on the real Android phone through Appium with the given chromedriver', () => {
    expect(capabilitiesFor('android', PHONES)).toMatchObject({
      'appium:udid': 'SERIAL1',
      platformName: 'Android',
      browserName: 'Chrome',
      'appium:automationName': 'UiAutomator2',
      'appium:chromedriverExecutable': '/cd',
    });
  });

  // OxygenOS refuses `pm clear com.android.chrome` from adb (no
  // CLEAR_APP_USER_DATA permission). Appium (noReset) and then chromedriver
  // (androidKeepAppDataDir) each clear it by default, stopping the session before
  // any test runs (OnePlus, 2026-11-06, both measured). Chrome keeps its data
  // between runs, as Safari does on the iPhone.
  // With BiDi, WebdriverIO cannot send Android's native selectors
  // (`android=new UiSelector()...`) once in NATIVE_APP: "Can't transform
  // classic selector -android uiautomator to Bidi selector" (OnePlus, 2026-11-06).
  it('drives Android over classic WebDriver, so the native picker and keyboard can be found', () => {
    expect(capabilitiesFor('android', PHONES)).toMatchObject({ 'wdio:enforceWebDriverClassic': true });
  });

  it("leaves Chrome's data alone on Android, so a phone that forbids clearing it can still run the suite", () => {
    expect(capabilitiesFor('android', PHONES)).toMatchObject({
      'appium:noReset': true,
      'goog:chromeOptions': { androidKeepAppDataDir: true },
    });
  });

  it('refuses Android without a chromedriver, naming the variable', () => {
    expect(() => capabilitiesFor('android', { androidSerial: 'SERIAL1' })).toThrow(
      'android needs E2E_CHROMEDRIVER: the path to a chromedriver matching Chrome on the phone',
    );
  });
});

describe('capabilitiesFor refuses a phone it cannot name, so Appium never picks a simulator', () => {
  it('refuses the iPhone without its UDID', () => {
    expect(() => capabilitiesFor('ios', {})).toThrow("ios needs E2E_IOS_UDID: the real iPhone's UDID (xcrun xctrace list devices)");
  });

  it('refuses Android without its serial', () => {
    expect(() => capabilitiesFor('android', { chromedriver: '/cd' })).toThrow(
      "android needs E2E_ANDROID_SERIAL: the real phone's serial (adb devices)",
    );
  });
});

describe('targetOf', () => {
  it('refuses a session it cannot place, naming its capabilities', () => {
    expect(() => targetOf({ browserName: 'edge' })).toThrow('no target for capabilities {"browserName":"edge"}');
  });
});

describe('nativeFinder', () => {
  it('finds an Android control by the start of its accessible name', () => {
    expect(nativeFinder('android', 'Your message')).toBe('android=new UiSelector().descriptionStartsWith("Your message")');
  });

  it('finds an iPhone control by its accessible name', () => {
    expect(nativeFinder('ios', 'Your message')).toBe("-ios predicate string:label == 'Your message'");
  });

  it.each([
    ['a double quote', 'say "hi"'],
    ['a single quote', "it's"],
    ['a backslash', 'a\\b'],
  ])('refuses a name holding %s rather than build a broken selector', (_case, label) => {
    expect(() => nativeFinder('ios', label)).toThrow(`accessible name cannot hold quotes or backslashes: ${label}`);
  });
});

describe('pickerItem', () => {
  it.each([
    ['photo.jpg', 'android=new UiSelector().descriptionStartsWith("Photo taken")'],
    ['ok-10s.mp4', 'android=new UiSelector().descriptionContains("with duration 00:10")'],
    ['long-45s.mp4', 'android=new UiSelector().descriptionContains("with duration 00:45")'],
  ] as const)('finds %s in the Android picker by its kind and length', (fixture, selector) => {
    expect(pickerItem('android', fixture)).toBe(selector);
  });

  it.each([
    ['photo.jpg', "-ios predicate string:label BEGINSWITH 'Photo'"],
    ['ok-10s.mp4', "-ios predicate string:label BEGINSWITH 'Video' AND label CONTAINS '10 seconds'"],
    ['long-45s.mp4', "-ios predicate string:label BEGINSWITH 'Video' AND label CONTAINS '45 seconds'"],
  ] as const)('finds %s in the iPhone picker by its kind and length', (fixture, selector) => {
    expect(pickerItem('ios', fixture)).toBe(selector);
  });
});
