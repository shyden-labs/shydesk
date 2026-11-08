import { describe, expect, it } from 'vitest';
import { hit } from '../../src/limits.ts';
import { standInDb } from './d1-stand-in.ts';

// Rate limits for the contact form (shyden-labs/shydesk#19): one counters row
// per key, counted in a fixed window that starts again once it has passed.
// The count and the window reset happen in one statement, so two requests at
// once can never both take the last place.
const NOW = 1_800_000_000_000;

describe('hit', () => {
  it('lets a request through while the count is within the limit', async () => {
    const { db } = standInDb(() => [{ value: 5 }]);
    expect(await hit(db, 'contact:email:a@b.co', 5, 3600, NOW)).toBe(true);
  });

  it('refuses the request that goes past the limit', async () => {
    const { db } = standInDb(() => [{ value: 6 }]);
    expect(await hit(db, 'contact:email:a@b.co', 5, 3600, NOW)).toBe(false);
  });

  it('refuses when no count came back', async () => {
    const { db } = standInDb(() => []);
    expect(await hit(db, 'contact:email:a@b.co', 5, 3600, NOW)).toBe(false);
  });

  it('counts in one statement, binding the key, this window start and when an old window ends', async () => {
    const { db, statements } = standInDb(() => [{ value: 1 }]);
    await hit(db, 'contact:ip:203.0.113.9', 20, 3600, NOW);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/INSERT INTO counters[\s\S]*ON CONFLICT[\s\S]*RETURNING value/);
    expect(statements[0]?.values).toEqual(['contact:ip:203.0.113.9', NOW, NOW - 3_600_000]);
  });
});
