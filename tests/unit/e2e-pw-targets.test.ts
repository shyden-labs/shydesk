import { describe, expect, it } from 'vitest';
import { targetForProject } from '../e2e-pw/harness/targets.ts';

// The Playwright suite (shyden-labs/shydesk#176) runs on the shared desktop browsers'
// project names; the pure helpers it reuses from the WebdriverIO suite take that suite's
// targets, so each project name maps to the target whose engine it drives.
describe('targetForProject', () => {
  it('maps the bundled Chromium to chromium', () => {
    expect(targetForProject('chromium')).toBe('chromium');
  });

  it('maps installed Chrome to chromium', () => {
    expect(targetForProject('chrome')).toBe('chromium');
  });

  it('maps installed Edge to chromium', () => {
    expect(targetForProject('msedge')).toBe('chromium');
  });

  it('maps Firefox to firefox', () => {
    expect(targetForProject('firefox')).toBe('firefox');
  });

  it('maps WebKit to safari', () => {
    expect(targetForProject('webkit')).toBe('safari');
  });

  it('refuses a project name it does not know, naming it', () => {
    expect(() => targetForProject('opera')).toThrow('no target for the Playwright project "opera"');
  });
});
