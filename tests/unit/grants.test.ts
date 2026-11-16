import { describe, expect, it } from 'vitest';
import { hashKey } from '../../src/products.ts';
import { GRANT_TTL_MS, MAX_GRANT_FILES, createGrant, grantLive, useGrant } from '../../src/reports/grants.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// Evidence upload grants (shyden-labs/shydesk#59; Release 2 plan Task 3): a product's
// server asks for one, hands it to its app, and the app uploads straight to ShyDesk
// with it. A grant is 32 random bytes, base64url; only its hash is stored, in
// `counters`, keyed to its product, with the files left and its expiry.

const NOW = 1_700_000_000_000;

describe('createGrant', () => {
  it('returns a 43-character base64url grant expiring in 15 minutes', async () => {
    const { db } = standInDb();
    const { grant, expires_at } = await createGrant(db, 'shytalk', 3, NOW);
    expect(grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(GRANT_TTL_MS).toBe(15 * 60 * 1000);
    expect(expires_at).toBe(NOW + GRANT_TTL_MS);
  });

  it('stores only the hash, keyed to the product, with the files left and the expiry', async () => {
    const { db, statements } = standInDb();
    const { grant } = await createGrant(db, 'shytalk', 3, NOW);
    const insert = statements.find((s) => /INSERT INTO counters/.test(s.sql));
    expect(insert?.values).toEqual([`grant:shytalk:${await hashKey(grant)}`, 3, NOW + GRANT_TTL_MS]);
    expect(statements.map((s) => s.values).flat()).not.toContain(grant);
  });

  it('clears expired grants in the same batch, with no clock', async () => {
    const { db, statements } = standInDb();
    await createGrant(db, 'shytalk', 1, NOW);
    expect(statements.map((s) => s.method)).toEqual(['batch', 'batch']);
    expect(statements[0]?.sql).toMatch(/DELETE FROM counters WHERE key LIKE 'grant:%' AND window_start <= \?/);
    expect(statements[0]?.values).toEqual([NOW]);
  });

  it('makes a different grant each time', async () => {
    const { db } = standInDb();
    expect((await createGrant(db, 'shytalk', 1, NOW)).grant).not.toBe((await createGrant(db, 'shytalk', 1, NOW)).grant);
  });

  it('allows at most 10 files', () => {
    expect(MAX_GRANT_FILES).toBe(10);
  });
});

/** Answers grant reads and uses from `left` files and `expiresAt`, as the SQL's conditions would. */
const grantRow =
  (key: string, left: number, expiresAt: number): Answer =>
  (sql, values) => {
    if (values[0] !== key) return [];
    const live = expiresAt > Number(values[1]);
    if (/UPDATE counters SET value = value - 1/.test(sql)) return live && left > 0 ? [{ value: left - 1 }] : [];
    if (/SELECT value FROM counters/.test(sql)) return live ? [{ value: left }] : [];
    return [];
  };

describe('useGrant', () => {
  it('takes one file off a live grant', async () => {
    const key = `grant:shytalk:${await hashKey('g')}`;
    const { db, statements } = standInDb(grantRow(key, 3, NOW + 1));
    await expect(useGrant(db, 'shytalk', 'g', NOW)).resolves.toBe(true);
    expect(statements[0]?.sql).toMatch(
      /UPDATE counters SET value = value - 1 WHERE key = \? AND value > 0 AND window_start > \? RETURNING value/,
    );
    expect(statements[0]?.values).toEqual([key, NOW]);
  });

  it('refuses an 11th file on a grant of 10, once all 10 are used', async () => {
    const key = `grant:shytalk:${await hashKey('g')}`;
    let left = 10;
    const { db } = standInDb((sql, values) => {
      const answer = grantRow(key, left, NOW + 1)(sql, values);
      if (answer.length > 0) left -= 1;
      return answer;
    });
    for (let n = 1; n <= 10; n += 1) await expect(useGrant(db, 'shytalk', 'g', NOW)).resolves.toBe(true);
    await expect(useGrant(db, 'shytalk', 'g', NOW)).resolves.toBe(false);
  });

  it('refuses a grant used after 15 minutes', async () => {
    const key = `grant:shytalk:${await hashKey('g')}`;
    const { db } = standInDb(grantRow(key, 3, NOW + GRANT_TTL_MS));
    await expect(useGrant(db, 'shytalk', 'g', NOW + GRANT_TTL_MS)).resolves.toBe(false);
  });

  it("refuses another product's grant, since the key names the product", async () => {
    const key = `grant:shytalk:${await hashKey('g')}`;
    const { db } = standInDb(grantRow(key, 3, NOW + 1));
    await expect(useGrant(db, 'yawelo-idle', 'g', NOW)).resolves.toBe(false);
  });
});

describe('grantLive', () => {
  it('is true for an unexpired grant, without using a file', async () => {
    const key = `grant:shytalk:${await hashKey('g')}`;
    const { db, statements } = standInDb(grantRow(key, 0, NOW + 1));
    await expect(grantLive(db, 'shytalk', 'g', NOW)).resolves.toBe(true);
    expect(statements.every((s) => s.method === 'first')).toBe(true);
    expect(statements[0]?.sql).toMatch(/SELECT value FROM counters WHERE key = \? AND window_start > \?/);
  });

  it('is false for an expired grant or one of another product', async () => {
    const key = `grant:shytalk:${await hashKey('g')}`;
    const { db } = standInDb(grantRow(key, 3, NOW));
    await expect(grantLive(db, 'shytalk', 'g', NOW)).resolves.toBe(false);
    await expect(grantLive(db, 'yawelo-idle', 'g', NOW - 1)).resolves.toBe(false);
  });
});
