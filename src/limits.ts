import type { D1Database } from '@cloudflare/workers-types';

/**
 * A fixed-window rate limit kept in `counters` (shyden-labs/shydesk#19). One
 * statement counts the request and starts a new window once the old one has
 * passed, so two requests at once can never both take the last place.
 * Returns true while the count, this request included, is within `limit`.
 *
 * Keys name a sender's IP address or email (shyden-labs/shydesk#110), so each
 * call first deletes every row whose window has passed: no such row is kept
 * more than one window after its last use. Every caller uses a one-hour
 * window, so no sweep cuts another key's window short. Counters without a
 * window (`feed_seq`, stored bytes) have a NULL `window_start` and are kept.
 */
const SWEEP = 'DELETE FROM counters WHERE window_start <= ?1';
const COUNT = `INSERT INTO counters (key, value, window_start) VALUES (?1, 1, ?2)
  ON CONFLICT (key) DO UPDATE SET
    value = CASE WHEN window_start <= ?3 THEN 1 ELSE value + 1 END,
    window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
  RETURNING value`;

export async function hit(db: D1Database, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<boolean> {
  const windowEnded = now - windowSeconds * 1000;
  await db.prepare(SWEEP).bind(windowEnded).run();
  const row = await db.prepare(COUNT).bind(key, now, windowEnded).first<{ value: number }>();
  return (row?.value ?? Number.POSITIVE_INFINITY) <= limit;
}
