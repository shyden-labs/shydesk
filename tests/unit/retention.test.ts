import { describe, it, expect } from 'vitest';
import { deleteAttachments, deleteText } from '../../src/timers/retention.ts';
import { standInDb } from './d1-stand-in.ts';

// Retention's statements carry the legal-hold check (shyden-labs/shydesk#62
// AC1). A stand-in cannot evaluate SQL, so what the check does is proven on
// real D1 in tests/integration/ticket-timers.test.ts; this pins that every
// statement that deletes asks for it.

const NOW = Date.UTC(2026, 10, 17, 12);
const files = { delete: () => Promise.resolve() };
const squash = (sql: string) => sql.replace(/\s+/g, ' ');

describe('retention and legal holds', () => {
  it('reads only attachments no active hold covers, on the ticket or on that attachment', async () => {
    const { db, statements } = standInDb();
    await deleteAttachments(db, files, 't1', NOW);
    expect(squash(statements[0]?.sql ?? '')).toContain(
      'NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.lifted_at IS NULL AND h.ticket_id = attachments.ticket_id AND (h.attachment_id IS NULL OR h.attachment_id = attachments.id))',
    );
  });

  it('deletes no text row while any hold on the ticket is active', async () => {
    const { db, statements } = standInDb();
    await deleteText(db, files, 't1', NOW);
    const deletes = statements.filter((s) => s.sql.startsWith('DELETE'));
    expect(deletes).toHaveLength(4);
    for (const s of deletes) {
      expect.soft(squash(s.sql)).toContain('NOT EXISTS (SELECT 1 FROM legal_holds WHERE lifted_at IS NULL AND ticket_id = ?)');
    }
  });
});
