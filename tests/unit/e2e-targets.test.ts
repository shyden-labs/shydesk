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

describe('capabilitiesFor and targetOf agree', () => {
  it.each(TARGETS.map((target) => [target]))('%s', (target) => {
    expect(targetOf(capabilitiesFor(target, { chromedriver: '/cd' }))).toBe(target);
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
    expect(capabilitiesFor('ios', {})).toMatchObject({
      platformName: 'iOS',
      browserName: 'Safari',
      'appium:automationName': 'XCUITest',
      'appium:nativeWebTap': true,
    });
  });

  it('drives Chrome on the real Android phone through Appium with the given chromedriver', () => {
    expect(capabilitiesFor('android', { chromedriver: '/cd' })).toMatchObject({
      platformName: 'Android',
      browserName: 'Chrome',
      'appium:automationName': 'UiAutomator2',
      'appium:chromedriverExecutable': '/cd',
    });
  });

  it('refuses Android without a chromedriver, naming the variable', () => {
    expect(() => capabilitiesFor('android', {})).toThrow(
      'android needs E2E_CHROMEDRIVER: the path to a chromedriver matching Chrome on the phone',
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
