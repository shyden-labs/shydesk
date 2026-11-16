// The row types carry the columns later migrations added (shyden-labs/shydesk#156):
// `tickets.token_sealed` (migrations/0003_ticket_token_sealed.sql, nullable text) and
// `attachments.received_bytes` (migrations/0002_upload_received_bytes.sql, integer, not null).
// `npm run typecheck` refuses these literals while a type lacks the column.
import { describe, expect, it } from 'vitest';
import type { AttachmentRow, TicketRow } from '../../src/db/types.ts';

describe('row types', () => {
  it('TicketRow has token_sealed, which a ticket from before 0003 leaves null', () => {
    const row: TicketRow = {
      id: 't1',
      product_id: 'p1',
      type_id: 'ty1',
      status: 'open',
      customer_email: 'a@example.test',
      subject: 'Subject',
      category: 'general',
      fields_json: '{}',
      token_hash: 'hash',
      created_at: 0,
      updated_at: 0,
      closed_at: null,
      seq: 1,
      token_sealed: null,
    };
    expect(row.token_sealed).toBeNull();
  });

  it('AttachmentRow has received_bytes, a count that is never null', () => {
    const row: AttachmentRow = {
      id: 'a1',
      product_id: 'p1',
      ticket_id: null,
      message_id: null,
      r2_key: 'key',
      r2_upload_id: null,
      thumb_key: null,
      mime: 'image/jpeg',
      bytes: 10,
      duration_ms: null,
      state: 'pending',
      created_at: 0,
      deleted_at: null,
      received_bytes: 0,
    };
    expect(row.received_bytes).toBe(0);
  });
});
