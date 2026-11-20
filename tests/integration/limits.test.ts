// The rate limit on a real D1 database (shyden-labs/shydesk#110): a window's
// row names a sender's IP address or email, so it is deleted once its window
// has passed, while counting still works and rows that are not rate limits
// stay. The clock is passed in, starting near zero, so these rows are older
// than any other file's and no other file's rows are swept here.
import { describe, expect, inject, it } from 'vitest';
import { hit } from '../../src/limits.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const HOUR = 3600;
const HOUR_MS = HOUR * 1000;

async function row(key: string): Promise<{ value: number; window_start: number | null } | null> {
  return db.prepare('SELECT value, window_start FROM counters WHERE key = ?').bind(key).first();
}

describe('rate limit rows', () => {
  it('counts within the window, refuses past the limit and starts again after it', async () => {
    const key = 'contact:ip:192.0.2.10';
    await expect(hit(db, key, 2, HOUR, 1_000)).resolves.toBe(true);
    await expect(hit(db, key, 2, HOUR, 2_000)).resolves.toBe(true);
    await expect(hit(db, key, 2, HOUR, 3_000)).resolves.toBe(false);
    await expect(hit(db, key, 2, HOUR, 1_000 + HOUR_MS + 1)).resolves.toBe(true);
    await expect(row(key)).resolves.toEqual({ value: 1, window_start: 1_000 + HOUR_MS + 1 });
  });

  it('lets only one of two requests at once take the last place', async () => {
    const key = 'reply:ip:192.0.2.11';
    await hit(db, key, 2, HOUR, 10_000);
    const both = await Promise.all([hit(db, key, 2, HOUR, 10_001), hit(db, key, 2, HOUR, 10_002)]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it('deletes a row naming an IP address or email once its window has passed', async () => {
    const start = 100_000;
    await hit(db, 'contact:ip:192.0.2.20', 20, HOUR, start);
    await hit(db, 'contact:email:sender@example.com', 5, HOUR, start);
    await hit(db, 'upload-ip:192.0.2.21', 20, HOUR, start);
    await hit(db, 'it-limits:other-key', 20, HOUR, start + HOUR_MS + 1);
    await expect(row('contact:ip:192.0.2.20')).resolves.toBeNull();
    await expect(row('contact:email:sender@example.com')).resolves.toBeNull();
    await expect(row('upload-ip:192.0.2.21')).resolves.toBeNull();
  });

  it('keeps a row whose window has not passed', async () => {
    const start = 200_000;
    await hit(db, 'contact:ip:192.0.2.30', 20, HOUR, start);
    await hit(db, 'it-limits:other-key-2', 20, HOUR, start + HOUR_MS - 1);
    await expect(row('contact:ip:192.0.2.30')).resolves.toEqual({ value: 1, window_start: start });
  });

  it('never deletes a counter that is not a rate limit', async () => {
    await db.prepare('INSERT INTO counters (key, value) VALUES (?, 7)').bind('it-limits:plain').run();
    await hit(db, 'it-limits:other-key-3', 20, HOUR, 300_000 + HOUR_MS * 24);
    await expect(row('it-limits:plain')).resolves.toEqual({ value: 7, window_start: null });
  });
});
