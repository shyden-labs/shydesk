import { describe, it, expect } from 'vitest';
import {
  capabilitiesFor,
  nativeFinder,
  pickerItem,
  targetOf,
  TARGETS,
  targetsFrom,
  screenPoint,
  viewportPoint,
  notNamedMessage,
  nameMatches,
  scrollNeeded,
} from '../e2e/harness/targets.ts';

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

  // The iPhone photo picker shows an album as a button holding a text of the
  // same name, so a match on the name alone finds two (measured 2026-11-06).
  it('finds an iPhone control by its accessible name, never the text inside it', () => {
    expect(nativeFinder('ios', 'Your message')).toBe(
      "-ios predicate string:label == 'Your message' AND type != 'XCUIElementTypeStaticText'",
    );
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

  // Measured on the iPhone, 2026-11-06: each item is an image labelled like
  // "Video, ten seconds, 06 November, 10.16" (the length in words), inside a
  // grid whose own label lists every item, so only images are matched.
  it.each([
    ['photo.jpg', "-ios predicate string:type == 'XCUIElementTypeImage' AND label BEGINSWITH 'Photo,'"],
    ['ok-10s.mp4', "-ios predicate string:type == 'XCUIElementTypeImage' AND label BEGINSWITH 'Video, ten seconds,'"],
    ['long-45s.mp4', "-ios predicate string:type == 'XCUIElementTypeImage' AND label BEGINSWITH 'Video, forty-five seconds,'"],
  ] as const)('finds %s in the iPhone picker by its kind and length', (fixture, selector) => {
    expect(pickerItem('ios', fixture)).toBe(selector);
  });
});

// Chrome on Android gives text fields no name in the native tree, however the
// page labels them (aria-label, label, label for, placeholder: all measured
// empty on the OnePlus, 2026-11-06), so a field is touched where it is drawn.
describe('screenPoint', () => {
  it('is the middle of the element, scaled by the pixel ratio, from where the page starts on screen', () => {
    expect(screenPoint({ x: 10, y: 20, width: 100, height: 40 }, 3, { x: 0, y: 356 })).toEqual({ x: 180, y: 476 });
  });

  it('adds a page area that does not start at the left edge', () => {
    expect(screenPoint({ x: 0, y: 0, width: 10, height: 10 }, 2, { x: 50, y: 100 })).toEqual({ x: 60, y: 110 });
  });

  it('rounds to whole device pixels', () => {
    expect(screenPoint({ x: 0, y: 0, width: 3, height: 3 }, 2.625, { x: 0, y: 0 })).toEqual({ x: 4, y: 4 });
  });
});

describe('viewportPoint', () => {
  it('is the middle of the element, rounded, in CSS pixels from the top-left of the viewport', () => {
    expect(viewportPoint({ x: 10, y: 20, width: 101, height: 41 }, { width: 800, height: 600 }, 'Email')).toEqual({ x: 61, y: 41 });
  });

  it('refuses an element drawn below the viewport, naming it', () => {
    expect(() => viewportPoint({ x: 0, y: 590, width: 10, height: 40 }, { width: 800, height: 600 }, 'Send')).toThrow(
      '"Send" is drawn outside the window (its middle is at 5, 610 in a 800 by 600 window)',
    );
  });

  it('refuses an element drawn left of the viewport, naming it', () => {
    expect(() => viewportPoint({ x: -30, y: 0, width: 10, height: 10 }, { width: 800, height: 600 }, 'Menu')).toThrow(
      '"Menu" is drawn outside the window (its middle is at -25, 5 in a 800 by 600 window)',
    );
  });

  it('refuses an element with no drawn size, naming it', () => {
    expect(() => viewportPoint({ x: 5, y: 5, width: 0, height: 0 }, { width: 800, height: 600 }, 'Hidden')).toThrow(
      '"Hidden" is not drawn (it has no size)',
    );
  });
});

describe('notNamedMessage', () => {
  it('names the label wanted and every distinct name the page did have', () => {
    expect(notNamedMessage('Harness file', ['Harness button', '', 'Browse… No file selected.', 'Harness button'])).toBe(
      'no element named "Harness file" appeared on the page; the names seen were: "Harness button", "", "Browse… No file selected."',
    );
  });

  it('says when the page had no candidate elements at all', () => {
    expect(notNamedMessage('Send', [])).toBe('no element named "Send" appeared on the page; it had no named elements at all');
  });
});

describe('nameMatches', () => {
  it('matches a control whose name is exactly the label', () => {
    expect(nameMatches('Email', 'Email', false)).toBe(true);
  });

  it('refuses a control whose name only starts with the label', () => {
    expect(nameMatches('Email', 'Email address', false)).toBe(false);
  });

  it("matches a file input whose name is the label followed by the browser's own button text", () => {
    expect(nameMatches('Harness file', 'Harness file Browse… No file selected.', true)).toBe(true);
  });

  it('refuses a file input whose name only shares the start of a word with the label', () => {
    expect(nameMatches('Harness file', 'Harness files Browse…', true)).toBe(false);
  });

  it('matches a file input named exactly the label', () => {
    expect(nameMatches('Photo', 'Photo', true)).toBe(true);
  });
});

describe('scrollNeeded', () => {
  it('is nothing for an element whose middle is in the window', () => {
    expect(scrollNeeded({ x: 0, y: 100, width: 10, height: 40 }, { width: 800, height: 600 })).toBe(0);
  });

  it('brings an element below the window to the middle of the window', () => {
    expect(scrollNeeded({ x: 0, y: 760, width: 10, height: 44 }, { width: 1366, height: 683 })).toBe(441);
  });

  it('brings an element above the window to the middle of the window, scrolling up', () => {
    expect(scrollNeeded({ x: 0, y: -400, width: 10, height: 40 }, { width: 800, height: 600 })).toBe(-680);
  });

  it('counts an element whose middle sits on the bottom edge as outside', () => {
    expect(scrollNeeded({ x: 0, y: 580, width: 10, height: 40 }, { width: 800, height: 600 })).toBe(300);
  });
});
