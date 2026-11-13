import { describe, it, expect } from 'vitest';
import {
  desktopFilePath,
  capabilitiesFor,
  nativeFinder,
  pickerItem,
  targetOf,
  TARGETS,
  targetsFrom,
  screenPoint,
  viewportPoint,
  notNamedMessage,
  typedMismatch,
  nameMatches,
  scrollNeeded,
  scrollInput,
  typed,
  pressMissed,
  type KeySequence,
  scrollKey,
  sameBox,
  iosNamed,
  iosPage,
  largest,
  inDocument,
  drawnAt,
  steadyFrom,
  steadyLongEnough,
  STEADY_MS,
  swipeUp,
  centreInside,
  ANDROID_KEYS,
  pinchOut,
  fingerSwipeLeft,
  androidPageArea,
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

const PHONES = {
  chromedriver: '/cd',
  desktopChromedriver: '/desktop-cd',
  geckodriver: '/gd',
  iosUdid: '0000-IPHONE',
  androidSerial: 'SERIAL1',
};

describe('capabilitiesFor and targetOf agree', () => {
  it.each(TARGETS.map((target) => [target]))('%s', (target) => {
    expect(targetOf(capabilitiesFor(target, PHONES))).toBe(target);
  });
});

describe('capabilitiesFor', () => {
  // A driver fetched mid-run turned a PR red on an outside 504 (shyden-labs/shydesk#77):
  // desktop Chrome and Firefox use the driver already on the machine.
  it('runs desktop Chrome headless with the given chromedriver', () => {
    expect(capabilitiesFor('chromium', PHONES)).toEqual({
      browserName: 'chrome',
      'goog:chromeOptions': { args: ['--headless=new'] },
      'wdio:chromedriverOptions': { binary: '/desktop-cd' },
    });
  });

  it('runs desktop Firefox headless with the given geckodriver', () => {
    expect(capabilitiesFor('firefox', PHONES)).toEqual({
      browserName: 'firefox',
      'moz:firefoxOptions': { args: ['-headless'] },
      'wdio:geckodriverOptions': { binary: '/gd' },
    });
  });

  it('refuses desktop Chrome without a chromedriver, naming the variable', () => {
    expect(() => capabilitiesFor('chromium', {})).toThrow(
      'chromium needs E2E_DESKTOP_CHROMEDRIVER: the path to a chromedriver matching the installed Chrome',
    );
  });

  it('refuses desktop Firefox without a geckodriver, naming the variable', () => {
    expect(() => capabilitiesFor('firefox', {})).toThrow('firefox needs E2E_GECKODRIVER: the path to a geckodriver');
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
  it('finds an Android control by the start of its description', () => {
    expect(nativeFinder('android', 'Your message')).toBe(
      '//*[starts-with(@content-desc, "Your message") or (@clickable="true" and @text="Your message")]',
    );
  });

  // Chrome on Android names a button by its visible text, with no description
  // ("Send": Button text="Send", content-desc empty, measured 2026-11-08); a
  // label beside a field holds the same text but cannot be tapped.
  it('also finds a tappable Android control by its visible text, never a plain label of the same text', () => {
    expect(nativeFinder('android', 'Send')).toContain('(@clickable="true" and @text="Send")');
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

  // A lookup that throws is retried until the wait ends; its error is the cause, so the failure names it (shyden-labs/shydesk#73).
  it('names the error the last lookup failed with', () => {
    expect(notNamedMessage('Email', [], 'Method is not implemented')).toBe(
      'no element named "Email" appeared on the page; it had no named elements at all; the last lookup failed: Method is not implemented',
    );
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

describe('pressMissed', () => {
  /** A press that met a paragraph because the page scrolled 60 px between aiming and pressing. */
  const landed = {
    x: 400,
    y: 300,
    on: 'p',
    inside: false,
    control: { x: 350, y: 250, width: 100, height: 44 },
    aimedScroll: 1200,
    pressedScroll: 1260,
  };

  it('is quiet when the press landed on the control', () => {
    expect(pressMissed('Send', { x: 400, y: 300 }, { ...landed, x: 400, y: 300, on: 'button', inside: true })).toBeUndefined();
  });

  it('names where the press landed, where the control was then drawn and how far the page had scrolled', () => {
    expect(pressMissed('Send', { x: 400, y: 300 }, landed)).toBe(
      'the press on "Send" at 400, 300 landed on <p> at 400, 300 instead; "Send" was then drawn at 350, 250 (100 x 44), ' +
        'page scrolled 1200 px when aimed and 1260 px when pressed',
    );
  });

  it('says so when no press reached the page at all', () => {
    expect(pressMissed('Send', { x: 400, y: 300 }, null)).toBe('the press on "Send" at 400, 300 never reached the page');
  });
});

describe('typed', () => {
  /** Records each key action in the order it was added. */
  function recorder(): KeySequence & { steps: string[] } {
    const steps: string[] = [];
    const sequence = {
      steps,
      down(key: string) {
        steps.push(`down ${key}`);
        return sequence;
      },
      up(key: string) {
        steps.push(`up ${key}`);
        return sequence;
      },
    };
    return sequence;
  }

  it('presses and lifts each key before the next, as a person types, so a repeated key or space is pressed again', () => {
    expect(typed(recorder(), 'pp a').steps).toEqual(['down p', 'up p', 'down p', 'up p', 'down  ', 'up  ', 'down a', 'up a']);
  });

  it('types a letter outside the basic plane as one key', () => {
    expect(typed(recorder(), '😀').steps).toEqual(['down 😀', 'up 😀']);
  });

  it('adds nothing for empty text', () => {
    expect(typed(recorder(), '').steps).toEqual([]);
  });

  it('returns the sequence it was given, ready to perform', () => {
    const sequence = recorder();
    expect(typed(sequence, 'a')).toBe(sequence);
  });
});

describe('scrollInput', () => {
  it('scrolls Chrome by the mouse wheel', () => {
    expect(scrollInput('chromium')).toBe('wheel');
  });

  it('scrolls Firefox by the mouse wheel', () => {
    expect(scrollInput('firefox')).toBe('wheel');
  });

  it("scrolls Safari by the keyboard, since Safari's driver performs no wheel scroll", () => {
    expect(scrollInput('safari')).toBe('keys');
  });
});

describe('scrollKey', () => {
  it('is Page Down to bring a control below the window up into it', () => {
    expect(scrollKey(441)).toBe('');
  });

  it('is Page Up to bring a control above the window down into it', () => {
    expect(scrollKey(-680)).toBe('');
  });
});

describe('steadyFrom', () => {
  const box = { x: 1, y: 300, width: 3, height: 4 };

  it('starts timing a control from its first read, so a first read is never steady', () => {
    const first = steadyFrom(undefined, box, 1000);
    expect(first).toEqual({ box, since: 1000 });
    expect(steadyLongEnough(first, 1000)).toBe(false);
  });

  it('keeps the time a control was first seen while it stays in place', () => {
    expect(steadyFrom({ box, since: 1000 }, { ...box }, 1100)).toEqual({ box, since: 1000 });
  });

  it('starts timing again when the control moved (two reads in one frame of a scroll match; the next ones do not)', () => {
    const moved = { ...box, y: 250 };
    expect(steadyFrom({ box, since: 1000 }, moved, 1100)).toEqual({ box: moved, since: 1100 });
  });

  it('counts a control steady once it has stayed put for STEADY_MS, and not a millisecond sooner', () => {
    expect(steadyLongEnough({ box, since: 1000 }, 1000 + STEADY_MS - 1)).toBe(false);
    expect(steadyLongEnough({ box, since: 1000 }, 1000 + STEADY_MS)).toBe(true);
  });
});

describe('sameBox', () => {
  it('is true for a control drawn in the same place twice', () => {
    expect(sameBox({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  });

  it('is false while the page is still scrolling the control upward', () => {
    expect(sameBox({ x: 1, y: 300, width: 3, height: 4 }, { x: 1, y: 250, width: 3, height: 4 })).toBe(false);
  });

  it('is false when the control moved sideways', () => {
    expect(sameBox({ x: 1, y: 2, width: 3, height: 4 }, { x: 9, y: 2, width: 3, height: 4 })).toBe(false);
  });

  it('is false when the control grew wider', () => {
    expect(sameBox({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 30, height: 4 })).toBe(false);
  });

  it('is false when the control grew taller', () => {
    expect(sameBox({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 40 })).toBe(false);
  });
});

describe('swipeUp', () => {
  it('drags a finger up the middle of the page area, from 70% to 30% of its height', () => {
    expect(swipeUp({ x: 0, y: 0, width: 1080, height: 2400 })).toEqual({ from: { x: 540, y: 1680 }, to: { x: 540, y: 720 } });
  });

  // With the on-screen keyboard up, the page area is the part above it
  // (a swipe that starts on the keyboard scrolls nothing, 2026-11-08).
  it('stays inside a page area that starts below the browser bar and ends above the keyboard', () => {
    expect(swipeUp({ x: 0, y: 356, width: 1440, height: 1200 })).toEqual({ from: { x: 720, y: 1196 }, to: { x: 720, y: 716 } });
  });

  it('rounds to whole pixels in an odd-sized area', () => {
    expect(swipeUp({ x: 1, y: 0, width: 375, height: 667 })).toEqual({ from: { x: 189, y: 467 }, to: { x: 189, y: 200 } });
  });
});

describe('centreInside', () => {
  const page = { x: 0, y: 356, width: 1440, height: 1531 };

  it('is true for a control whose middle is inside the page area', () => {
    expect(centreInside({ x: 112, y: 1500, width: 1218, height: 161 }, page)).toBe(true);
  });

  // Measured on the OnePlus, 2026-11-08: Send at y 2820 sat under the keyboard,
  // below the page area that ends at 1887, and a tap there hit the keyboard.
  it('is false for a control under the keyboard, below the page area', () => {
    expect(centreInside({ x: 112, y: 2820, width: 1218, height: 161 }, page)).toBe(false);
  });

  it('is false for a control above the page area, under the browser bar', () => {
    expect(centreInside({ x: 112, y: 200, width: 100, height: 100 }, page)).toBe(false);
  });

  it('is false for a control whose middle is right of the page area', () => {
    expect(centreInside({ x: 1500, y: 1000, width: 100, height: 100 }, page)).toBe(false);
  });

  it('is false for a control whose middle is left of the page area', () => {
    expect(centreInside({ x: -300, y: 1000, width: 100, height: 100 }, page)).toBe(false);
  });

  it('counts a middle exactly on the bottom edge as outside', () => {
    expect(centreInside({ x: 0, y: 1837, width: 100, height: 100 }, page)).toBe(false);
  });
});

describe('typedMismatch', () => {
  it('says nothing when the field holds exactly what was typed', () => {
    expect(typedMismatch('Subject', 'The app will not open', 'The app will not open')).toBeUndefined();
  });

  it('names the field, the typed text and what it held when keys were lost (Safari, run 42440108844)', () => {
    expect(typedMismatch('Subject', 'The app will not open', 'The apwilnotopen')).toBe(
      '"Subject" held "The apwilnotopen" after typing "The app will not open"; the browser lost or changed key presses',
    );
  });

  it('counts a field left empty as a mismatch', () => {
    expect(typedMismatch('Device', 'Test phone', '')).toBe(
      '"Device" held "" after typing "Test phone"; the browser lost or changed key presses',
    );
  });
});

// iOS Safari has no Get Computed Label (shyden-labs/shydesk#73), so on the
// iPhone the harness reads the name iOS itself gives each control, in the
// native tree, and finds the page element drawn in that place.
describe('iosNamed', () => {
  it('finds a control named exactly, or named with the role iOS appends after a comma', () => {
    expect(iosNamed('Support status')).toBe(
      "-ios predicate string:(label == 'Support status' OR label BEGINSWITH 'Support status, ') AND type != 'XCUIElementTypeStaticText'",
    );
  });

  it('refuses a name it cannot quote', () => {
    expect(() => iosNamed("it's")).toThrow("accessible name cannot hold quotes or backslashes: it's");
  });
});

describe('iosPage', () => {
  it('finds the page area iOS names after the document title', () => {
    expect(iosPage('Demo support page')).toBe("-ios predicate string:label == 'Demo support page' AND type == 'XCUIElementTypeOther'");
  });
});

describe('largest', () => {
  it('picks the page itself over a heading of the same name', () => {
    const page = { x: 0, y: 45, width: 420, height: 910 };
    expect(largest([{ x: 16, y: 82, width: 388, height: 41 }, page])).toEqual(page);
  });

  it('is undefined when there is nothing to pick', () => {
    expect(largest([])).toBeUndefined();
  });
});

describe('inDocument', () => {
  // Measured on the iPhone Air, 2026-11-08: the page area at y 68, "Harness field" at native 16,140 and CSS 16,72.
  it("places a native box in the document, from the page area's corner", () => {
    expect(inDocument({ x: 16, y: 140, width: 265, height: 60 }, { x: 0, y: 68, width: 420, height: 746 }, 1)).toEqual({
      x: 16,
      y: 72,
      width: 265,
      height: 60,
    });
  });

  it('counts a page scrolled up past the top bar', () => {
    expect(inDocument({ x: 32, y: 258, width: 356, height: 44 }, { x: 0, y: 45, width: 420, height: 910 }, 1)).toEqual({
      x: 32,
      y: 213,
      width: 356,
      height: 44,
    });
  });

  it('scales a zoomed page back to CSS pixels', () => {
    expect(inDocument({ x: 20, y: 40, width: 100, height: 50 }, { x: 0, y: 0, width: 420, height: 800 }, 0.5)).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 25,
    });
  });
});

describe('drawnAt', () => {
  it('matches a native box rounded to whole points', () => {
    expect(drawnAt({ x: 16, y: 16, width: 91, height: 48 }, { x: 16, y: 16, width: 90.515625, height: 48 })).toBe(true);
  });

  // Measured on the iPhone Air, 2026-11-08: the focused "Email" field is 44 points tall natively, 42 CSS pixels on the page.
  it('matches a focused field iOS draws a point bigger on each side', () => {
    expect(drawnAt({ x: 32, y: 213, width: 356, height: 44 }, { x: 32, y: 213.875, width: 356, height: 42 })).toBe(true);
  });

  it('does not match the next field down the form', () => {
    expect(drawnAt({ x: 32, y: 213, width: 356, height: 44 }, { x: 32, y: 291.875, width: 356, height: 42 })).toBe(false);
  });

  it('does not match the form around the field', () => {
    expect(drawnAt({ x: 32, y: 213, width: 356, height: 44 }, { x: 16, y: 100, width: 388, height: 600 })).toBe(false);
  });

  it('does not match a field inside the box', () => {
    expect(drawnAt({ x: 16, y: 100, width: 388, height: 600 }, { x: 32, y: 213, width: 356, height: 44 })).toBe(false);
  });

  it('does not match a button beside it', () => {
    expect(drawnAt({ x: 16, y: 16, width: 91, height: 48 }, { x: 120, y: 16, width: 91, height: 48 })).toBe(false);
  });
});

describe('desktopFilePath', () => {
  const fixture = '/repo/tests/fixtures/media/photo.jpg';

  it.each(['chromium', 'firefox'] as const)('gives %s the fixture where it is', (target) => {
    expect(desktopFilePath(target, fixture, '/Users/runner')).toBe(fixture);
  });

  it('gives Safari a copy in its own cache folder, the only kind of place it can read a WebDriver file from (measured, shyden-labs/shydesk#21)', () => {
    expect(desktopFilePath('safari', fixture, '/Users/runner')).toBe('/Users/runner/Library/Caches/com.apple.Safari/photo.jpg');
  });
});

describe('pressMissed on a press that loads a new page', () => {
  it('counts as reached: only a new page has no note of the press at all', () => {
    expect(pressMissed('Demo', { x: 1, y: 2 }, undefined)).toBeUndefined();
  });

  it('still names a press that never reached a page that stayed', () => {
    expect(pressMissed('Demo', { x: 1, y: 2 }, null)).toContain('never reached the page');
  });
});

describe('phone gestures (shyden-labs/shydesk#99)', () => {
  it("sends Android's own key codes for the viewer's keys: Escape, the left and right arrows, and R", () => {
    expect(ANDROID_KEYS).toEqual({ Escape: 111, ArrowLeft: 21, ArrowRight: 22, r: 46 });
  });

  it('spreads two fingers apart sideways from 40 to 120 CSS px either side of the point, in screen px', () => {
    expect(pinchOut({ x: 500, y: 900 }, 3)).toEqual([
      { from: { x: 380, y: 900 }, to: { x: 140, y: 900 } },
      { from: { x: 620, y: 900 }, to: { x: 860, y: 900 } },
    ]);
  });

  it('moves one finger from 100 CSS px right of the point to 100 CSS px left of it, in screen px', () => {
    expect(fingerSwipeLeft({ x: 500, y: 900 }, 2.5)).toEqual({ from: { x: 750, y: 900 }, to: { x: 250, y: 900 } });
  });

  it('rounds gesture points to whole screen pixels', () => {
    expect(fingerSwipeLeft({ x: 10, y: 20 }, 1.333)).toEqual({ from: { x: 143, y: 20 }, to: { x: -123, y: 20 } });
  });
});

describe('androidPageArea (shyden-labs/shydesk#99)', () => {
  // Measured on the OnePlus, 2026-11-12: Chrome's coordinator view ends where the page does, at 3014,
  // and the page view then ran from 356 to 3014 at 3.5 screen px per CSS px (2658 px tall).
  it("is the strip of Chrome's coordinator view, ending at its bottom, as tall as the page's window", () => {
    expect(androidPageArea({ x: 0, y: 160, width: 1440, height: 2854 }, 759.43, 3.5)).toEqual({ x: 0, y: 356, width: 1440, height: 2658 });
  });

  it('refuses a page window taller than the coordinator view, naming both', () => {
    expect(() => androidPageArea({ x: 0, y: 160, width: 1440, height: 1000 }, 759.43, 3.5)).toThrow(
      "android: the page's window (2658 px) is taller than Chrome's coordinator view (1000 px)",
    );
  });
});
