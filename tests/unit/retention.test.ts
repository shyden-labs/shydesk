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
    const writes = statements.filter((s) => /^(DELETE|UPDATE)/.test(s.sql));
    expect(writes).toHaveLength(8);
    for (const s of writes) {
      expect.soft(squash(s.sql)).toContain('NOT EXISTS (SELECT 1 FROM legal_holds WHERE lifted_at IS NULL AND ticket_id = ?)');
    }
  });
});

// Shyden's ruling 2026-11-17 (shyden-labs/shydesk#191): the text goes on time, and a bare ticket row stays while
// Release 2 records point at it. What each condition matches is proven on real D1 in
// tests/integration/ticket-timers.test.ts.
describe('a bare ticket row after the text goes', () => {
  const textWrites = async () => {
    const { db, statements } = standInDb();
    await deleteText(db, files, 't1', NOW);
    return statements.filter((s) => s.method === 'batch').map((s) => ({ sql: squash(s.sql), values: s.values }));
  };

  it('keeps the attachment rows a legal hold names, detached from the messages that go', async () => {
    const writes = await textWrites();
    expect(writes[0]?.sql).toMatch(
      /^UPDATE attachments SET message_id = NULL WHERE .*id IN \(SELECT attachment_id FROM legal_holds WHERE attachment_id IS NOT NULL\)/,
    );
    expect(writes[1]?.sql).toMatch(
      /^DELETE FROM attachments WHERE .*id NOT IN \(SELECT attachment_id FROM legal_holds WHERE attachment_id IS NOT NULL\)/,
    );
  });

  // shyden-labs/shydesk#232: a notice row holds the customer's address, so it goes with the text.
  it("deletes the ticket's notices in the same batch, while closed and not held", async () => {
    const writes = await textWrites();
    const notices = writes.findIndex((w) => w.sql.startsWith('DELETE FROM notices WHERE '));
    expect(notices).toBeGreaterThanOrEqual(0);
    expect(writes[notices]?.sql).toContain("ticket_id IN (SELECT id FROM tickets WHERE id = ? AND status = 'closed')");
    expect(writes[notices]?.values).toEqual(['t1', 't1']);
    expect(notices).toBeLessThan(writes.findIndex((w) => w.sql.startsWith('UPDATE tickets')));
  });

  it('blanks the report text and reporter, keeping who and what was reported', async () => {
    const report = (await textWrites()).find((w) => w.sql.startsWith('UPDATE reports'));
    expect(report?.sql).toContain("SET reporter_id = '', reason = '', context_json = '{}'");
    expect(report?.sql).not.toMatch(/subject_user_id|item_id =/);
  });

  it('blanks the ticket’s personal fields, kills its link and marks when the text went', async () => {
    const ticket = (await textWrites()).find((w) => w.sql.startsWith('UPDATE tickets'));
    expect(ticket?.sql).toContain(
      "SET customer_email = '', subject = '', category = '', fields_json = '{}', token_hash = 'deleted:' || id, token_sealed = NULL, text_deleted_at = ?",
    );
    expect(ticket?.values[0]).toBe(NOW);
  });

  it('deletes the ticket row only when nothing points at it, after blanking it', async () => {
    const writes = await textWrites();
    const last = writes.at(-1);
    expect(last?.sql).toMatch(/^DELETE FROM tickets /);
    for (const table of ['reports', 'punishments', 'appeals', 'legal_holds', 'authority_reports', 'attachments']) {
      expect.soft(last?.sql).toContain(`NOT EXISTS (SELECT 1 FROM ${table} WHERE`);
    }
  });
});
