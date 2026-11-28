/**
 * The browser engine a Playwright project drives (shyden-labs/shydesk#176), so the Playwright
 * suite can reuse the pure helpers in tests/e2e/harness/targets.ts that were measured per engine.
 */
import type { DesktopEngine } from '../../e2e/harness/targets.ts';

const TARGET_OF_PROJECT: Readonly<Record<string, DesktopEngine>> = {
  chromium: 'chromium',
  chrome: 'chromium',
  msedge: 'chromium',
  firefox: 'firefox',
  webkit: 'safari',
};

export function targetForProject(name: string): DesktopEngine {
  const target = TARGET_OF_PROJECT[name];
  if (target === undefined) throw new Error(`no target for the Playwright project "${name}"`);
  return target;
}
