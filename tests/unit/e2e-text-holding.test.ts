/**
 * shyden-labs/shydesk#294: a text wait that times out names the text it last
 * read. The message was built before the wait read anything, so every failure
 * said `it held ""` even while the field held "Ready to send" (scratch PR
 * shyden-labs/shydesk#293).
 */
import { describe, it, expect, vi } from 'vitest';

let shown: string | Error = 'Ready to send';

/** A session whose wait polls until the condition holds or its time is up, then throws the message it was given. */
const session = {
  waitUntil: vi.fn(async (condition: () => Promise<boolean>, options: { timeout: number; timeoutMsg: string }) => {
    const start = Date.now();
    while (!(await condition())) {
      if (Date.now() - start > options.timeout) throw new Error(options.timeoutMsg);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }),
};

vi.mock('../e2e/harness/driver.ts', () => ({ driver: () => session }));
vi.mock('../e2e/harness/find.ts', () => ({
  named: () => Promise.resolve({ getText: () => (shown instanceof Error ? Promise.reject(shown) : Promise.resolve(shown)) }),
  JOURNEY_WAIT: 20_000,
}));

const { textHolding } = await import('../e2e/harness/text.ts');

describe('textHolding', () => {
  it('names the text it last read when the wait times out', async () => {
    shown = 'Ready to send';
    await expect(textHolding('Support status', 'Check the fields marked below.', 50)).rejects.toThrow(
      '"Support status" never held "Check the fields marked below."; it held "Ready to send"',
    );
  });

  it('returns the text once it holds what is expected', async () => {
    shown = 'Check the fields marked below.';
    await expect(textHolding('Support status', 'Check the fields', 50)).resolves.toBe('Check the fields marked below.');
  });

  it('lets any other failure through as it was', async () => {
    shown = new Error('stale element reference');
    await expect(textHolding('Support status', 'Check the fields', 50)).rejects.toThrow(/^stale element reference$/);
  });
});
