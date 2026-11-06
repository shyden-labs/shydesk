import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// A session that fails to start fails once, naming its cause (global rule: a
// retry is not a fix; shyden-labs/shydesk#49). WebdriverIO retries a failed
// session start 3 times unless told otherwise, and an invalid capability was
// sent 4 times on the OnePlus on 2026-11-06.
const text = readFileSync(new URL('../../wdio.conf.ts', import.meta.url), 'utf8');

describe('wdio.conf.ts retries', () => {
  it('turns off connection retries', () => {
    expect(text).toMatch(/^\s*connectionRetryCount: 0,$/m);
  });

  it.each(['specFileRetries', 'specFileRetriesDelay', 'retries'])('sets no %s', (key) => {
    expect(text).not.toMatch(new RegExp(`\\b${key}\\s*:`));
  });
});
