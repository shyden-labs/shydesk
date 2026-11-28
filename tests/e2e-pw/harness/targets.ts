/**
 * The WebdriverIO suite's target for a Playwright project (shyden-labs/shydesk#176), so the
 * Playwright suite can reuse that suite's pure helpers: each shared desktop browser maps to the
 * target whose engine it drives.
 */
import type { Target } from '../../e2e/harness/targets.ts';

const TARGET_OF_PROJECT: Readonly<Record<string, Target>> = {
  chromium: 'chromium',
  chrome: 'chromium',
  msedge: 'chromium',
  firefox: 'firefox',
  webkit: 'safari',
};

export function targetForProject(name: string): Target {
  const target = TARGET_OF_PROJECT[name];
  if (target === undefined) throw new Error(`no target for the Playwright project "${name}"`);
  return target;
}
