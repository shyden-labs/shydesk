import type { D1Database } from '@cloudflare/workers-types';

/**
 * A fixed-window rate limit kept in `counters` (shyden-labs/shydesk#19). One
 * statement counts the request and starts a new window once the old one has
 * passed, so two requests at once can never both take the last place.
 * Returns true while the count, this request included, is within `limit`.
 */
const COUNT = `INSERT INTO counters (key, value, window_start) VALUES (?1, 1, ?2)
  ON CONFLICT (key) DO UPDATE SET
    value = CASE WHEN window_start <= ?3 THEN 1 ELSE value + 1 END,
    window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
  RETURNING value`;

export async function hit(db: D1Database, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<boolean> {
  const row = await db
    .prepare(COUNT)
    .bind(key, now, now - windowSeconds * 1000)
    .first<{ value: number }>();
  return (row?.value ?? Number.POSITIVE_INFINITY) <= limit;
}
