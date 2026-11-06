import { describe, it, expect } from 'vitest';
import { FREE_STORAGE_BYTES, STORED_BYTES, storageWarning, storedBytes } from '../../src/storage.ts';
import { standInDb } from './d1-stand-in.ts';

// The running total of attachment bytes in R2 and the admin desk's warning
// (shyden-labs/shydesk#22 AC3): shown from 80 % of the free 10 GB, not at 79.9 %.

describe('FREE_STORAGE_BYTES', () => {
  it('is 10 GB read as 10^9 bytes each, the smaller of the two readings, so the free tier is never passed', () => {
    expect(FREE_STORAGE_BYTES).toBe(10_000_000_000);
  });
});

describe('storageWarning', () => {
  it('is hidden at 79.9 %', () => {
    expect(storageWarning(7_990_000_000)).toBeNull();
  });

  it('is hidden one byte under 80 %', () => {
    expect(storageWarning(7_999_999_999)).toBeNull();
  });

  it('shows at exactly 80 %', () => {
    expect(storageWarning(8_000_000_000)).toBe('Attachment storage at 80 % of the free 10 GB.');
  });

  it('rounds the percentage down', () => {
    expect(storageWarning(9_999_999_999)).toBe('Attachment storage at 99 % of the free 10 GB.');
  });

  it('shows past 100 %', () => {
    expect(storageWarning(12_000_000_000)).toBe('Attachment storage at 120 % of the free 10 GB.');
  });

  it('is hidden when nothing is stored', () => {
    expect(storageWarning(0)).toBeNull();
  });
});

describe('storedBytes', () => {
  it('reads the stored_bytes counter', async () => {
    const { db, statements } = standInDb((sql, values) =>
      sql.includes('FROM counters') && values[0] === STORED_BYTES ? [{ value: 1234 }] : [],
    );
    expect(await storedBytes(db)).toBe(1234);
    expect(statements).toHaveLength(1);
  });

  it('is 0 before the first upload has created the counter', async () => {
    expect(await storedBytes(standInDb().db)).toBe(0);
  });
});
