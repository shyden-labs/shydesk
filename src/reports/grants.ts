import type { D1Database } from '@cloudflare/workers-types';
import { hashKey } from '../products.ts';

/**
 * Evidence upload grants (shyden-labs/shydesk#59; Release 2 plan Task 3). A
 * product's server asks for one with its API key and hands it to its app, which
 * uploads the evidence straight to ShyDesk (spec, "Reports API"). A grant is 32
 * random bytes, base64url, returned once. Only its hash is kept, in `counters`,
 * under a key naming its product: `value` is the files it may still start and
 * `window_start` is when it expires. Expired grants are cleared each time a new
 * one is made, with no clock.
 */

export const GRANT_TTL_MS = 15 * 60 * 1000;
export const MAX_GRANT_FILES = 10;

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const grantKey = async (productId: string, grant: string): Promise<string> => `grant:${productId}:${await hashKey(grant)}`;

/** Makes a grant for `count` files (1 to MAX_GRANT_FILES, checked by the caller). */
export async function createGrant(
  db: D1Database,
  productId: string,
  count: number,
  now = Date.now(),
): Promise<{ grant: string; expires_at: number }> {
  const grant = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + GRANT_TTL_MS;
  await db.batch([
    db.prepare("DELETE FROM counters WHERE key LIKE 'grant:%' AND window_start <= ?").bind(now),
    db.prepare('INSERT INTO counters (key, value, window_start) VALUES (?, ?, ?)').bind(await grantKey(productId, grant), count, expiresAt),
  ]);
  return { grant, expires_at: expiresAt };
}

/** Takes one file off an unexpired grant of this product; false when there is none left, or no such grant. */
export async function useGrant(db: D1Database, productId: string, grant: string, now = Date.now()): Promise<boolean> {
  const row = await db
    .prepare('UPDATE counters SET value = value - 1 WHERE key = ? AND value > 0 AND window_start > ? RETURNING value')
    .bind(await grantKey(productId, grant), now)
    .first<{ value: number }>();
  return row !== null;
}

/** True while a grant of this product is unexpired, used up or not: its uploads may finish. */
export async function grantLive(db: D1Database, productId: string, grant: string, now = Date.now()): Promise<boolean> {
  const row = await db
    .prepare('SELECT value FROM counters WHERE key = ? AND window_start > ?')
    .bind(await grantKey(productId, grant), now)
    .first<{ value: number }>();
  return row !== null;
}
