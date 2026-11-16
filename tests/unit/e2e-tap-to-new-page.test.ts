/**
 * shyden-labs/shydesk#163 AC1: a press that loads a new page runs no script in
 * the page it leaves. Chrome answered a script sent while its page was being
 * replaced with "Cannot find context with specified id" (develop run
 * 43806120089, `tapToNewPage('Send reply')`), so the harness must wait for the
 * new page before it asks the browser anything.
 */
import { describe, it, expect, vi } from 'vitest';

const calls: string[] = [];

/** A desktop Chrome session that records each call, with the control drawn inside the window. */
const session = {
  capabilities: { browserName: 'chrome' },
  execute: vi.fn((script: string) => {
    calls.push(`execute: ${script}`);
    if (script.includes('getBoundingClientRect(); return { box')) {
      return Promise.resolve({ box: { x: 10, y: 10, width: 40, height: 20 }, viewport: { width: 800, height: 600 } });
    }
    if (script.includes('__e2eLeaving === undefined')) return Promise.resolve(true);
    return Promise.resolve(undefined);
  }),
  waitUntil: vi.fn(async (condition: () => Promise<boolean>) => {
    // Polls as WebdriverIO does; the steadiness wait needs reads 300 ms apart.
    const start = Date.now();
    while (!(await condition())) {
      if (Date.now() - start > 900) throw new Error('waitUntil timed out in the stand-in');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }),
  action: vi.fn(() => {
    const chain = {
      move: () => chain,
      down: () => chain,
      pause: () => chain,
      up: () => chain,
      perform: () => {
        calls.push('press');
        return Promise.resolve();
      },
    };
    return chain;
  }),
};

vi.mock('../e2e/harness/driver.ts', () => ({ driver: () => session }));
vi.mock('../e2e/harness/find.ts', () => ({ named: () => Promise.resolve({}), JOURNEY_WAIT: 20_000 }));

const { tapToNewPage } = await import('../e2e/harness/input.ts');

describe('tapToNewPage', () => {
  it('asks nothing of the page it leaves between the press and the new page being ready', async () => {
    await tapToNewPage('Send reply');
    const afterPress = calls.slice(calls.indexOf('press') + 1);
    expect(afterPress[0]).toContain('__e2eLeaving === undefined');
  });
});
