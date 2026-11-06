import { describe, it, expect } from 'vitest';
import { overdue, overdueLine } from '../../src/desk/overdue.ts';
import { standInDb } from './d1-stand-in.ts';

// What a failed timer left behind (shyden-labs/shydesk#22 AC3), worked out when
// the admin desk loads, with no job: the SQL itself is checked on a real D1 in
// tests/integration/ticket-timers.test.ts; here, what is asked and what is shown.

const NOW = Date.UTC(2026, 10, 6, 12);

describe('overdue', () => {
  it('asks once, with the time now for each of the four kinds, and returns the rows oldest due first', async () => {
    const rows = [
      { kind: 'attachment', id: 'a1', product_id: 'shytalk', due_at: NOW - 2 },
      { kind: 'text', id: 't1', product_id: 'shytalk', due_at: NOW - 1 },
    ];
    const { db, statements } = standInDb(() => rows);
    expect(await overdue(db, NOW)).toEqual([
      { kind: 'attachment', id: 'a1', productId: 'shytalk', dueAt: NOW - 2 },
      { kind: 'text', id: 't1', productId: 'shytalk', dueAt: NOW - 1 },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toEqual([NOW, NOW, NOW, NOW]);
    expect(statements[0]?.sql).toContain('ORDER BY due_at');
  });

  it('is empty when nothing is past due', async () => {
    expect(await overdue(standInDb().db, NOW)).toEqual([]);
  });
});

describe('overdueLine', () => {
  const at = Date.UTC(2026, 9, 1, 8, 5);
  it.each([
    ['attachment', 'Attachment a1 (shytalk) was due for deletion at 2026-10-01 08:05 UTC and is still stored.'],
    ['text', 'Ticket a1 (shytalk) was due for text deletion at 2026-10-01 08:05 UTC and is still stored.'],
    ['autoclose', 'Ticket a1 (shytalk) was due to close itself at 2026-10-01 08:05 UTC and is still waiting.'],
    ['upload', 'Upload a1 (shytalk) was due to be aborted at 2026-10-01 08:05 UTC and is still pending.'],
  ] as const)('names a missed %s', (kind, line) => {
    expect(overdueLine({ kind, id: 'a1', productId: 'shytalk', dueAt: at })).toBe(line);
  });
});
