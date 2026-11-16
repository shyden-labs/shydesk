import type { D1Database } from '@cloudflare/workers-types';

/**
 * A fixed-window rate limit kept in `counters` (shyden-labs/shydesk#19). One
 * statement counts the request and starts a new window once the old one has
 * passed, so two requests at once can never both take the last place.
 * Returns true while the count, this request included, is within `limit`.
 *
 * Keys name a sender's IP address or email (shyden-labs/shydesk#110), so each
 * call first deletes every row whose window started over an hour ago: no such
 * row is kept more than an hour after its last use. The sweep always waits the
 * longest window, one hour, whatever the caller's own window, so a caller
 * counting per minute (reports, shyden-labs/shydesk#59) never deletes an hour
 * key's live row; a window longer than the hour is refused. Counters without a
 * window (`feed_seq`, stored bytes) have a NULL `window_start` and are kept.
 */
const SWEEP_AFTER_SECONDS = 3600;
const SWEEP = 'DELETE FROM counters WHERE window_start <= ?1';
const COUNT = `INSERT INTO counters (key, value, window_start) VALUES (?1, 1, ?2)
  ON CONFLICT (key) DO UPDATE SET
    value = CASE WHEN window_start <= ?3 THEN 1 ELSE value + 1 END,
    window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
  RETURNING value`;

export async function hit(db: D1Database, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<boolean> {
  if (windowSeconds > SWEEP_AFTER_SECONDS) throw new RangeError(`A rate window is at most ${String(SWEEP_AFTER_SECONDS)} seconds.`);
  const windowEnded = now - windowSeconds * 1000;
  await db
    .prepare(SWEEP)
    .bind(now - SWEEP_AFTER_SECONDS * 1000)
    .run();
  const row = await db.prepare(COUNT).bind(key, now, windowEnded).first<{ value: number }>();
  return (row?.value ?? Number.POSITIVE_INFINITY) <= limit;
}
