import type { D1Database } from '@cloudflare/workers-types';

/**
 * Attachment storage against R2's free tier (shyden-labs/shydesk#22, shyden-labs/shydesk#20).
 * R2's pricing page gives the free tier as "10 GB-month" without saying whether
 * a GB is 10^9 or 2^30 bytes, so this takes the smaller reading: staying under
 * it stays free whichever is meant.
 */
export const FREE_STORAGE_BYTES = 10_000_000_000;

/** The `counters` key holding the bytes of every stored attachment and thumbnail. */
export const STORED_BYTES = 'stored_bytes';

/** The running total; 0 before the first upload creates the counter. */
export async function storedBytes(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT value FROM counters WHERE key = ?').bind(STORED_BYTES).first<{ value: number }>();
  return row?.value ?? 0;
}

/**
 * Adds to the running total unless that would pass the free tier, in one
 * statement so two uploads finishing together cannot both take the last room.
 * False when there is no room, and nothing was added.
 */
export async function addStoredWithin(db: D1Database, bytes: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO counters (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = value + ?2 WHERE value + ?2 <= ?3
       RETURNING value`,
    )
    .bind(STORED_BYTES, bytes, FREE_STORAGE_BYTES)
    .first<{ value: number }>();
  return row !== null;
}

/** The admin desk's warning from 80 % of the free tier, the percentage rounded down; null below it. */
export function storageWarning(stored: number): string | null {
  if (stored * 5 < FREE_STORAGE_BYTES * 4) return null;
  return `Attachment storage at ${Math.floor((stored * 100) / FREE_STORAGE_BYTES)} % of the free 10 GB.`;
}
