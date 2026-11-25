// The row types carry the columns later migrations added (shyden-labs/shydesk#156):
// `tickets.token_sealed` (migrations/0003_ticket_token_sealed.sql, nullable text) and
// `attachments.received_bytes` (migrations/0002_upload_received_bytes.sql, integer, not null).
// `npm run typecheck` refuses these literals while a type lacks the column.
import { describe, expect, it } from 'vitest';
import type { AttachmentRow, ProductRow, TicketRow } from '../../src/db/types.ts';

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
      text_deleted_at: null,
      test_origin: null,
      first_notice_unsent: null,
    };
    expect(row.token_sealed).toBeNull();
  });

  it('TicketRow has text_deleted_at, null until the text timer leaves a bare row (shyden-labs/shydesk#191)', () => {
    const row: Pick<TicketRow, 'text_deleted_at'> = { text_deleted_at: null };
    expect(row.text_deleted_at).toBeNull();
  });

  it('TicketRow has test_origin, null for a ticket from a live site (shyden-labs/shydesk#263)', () => {
    const row: Pick<TicketRow, 'test_origin'> = { test_origin: null };
    expect(row.test_origin).toBeNull();
  });

  it("TicketRow has first_notice_unsent, why the new ticket's first email was not sent (shyden-labs/shydesk#274)", () => {
    const row: Pick<TicketRow, 'first_notice_unsent'> = { first_notice_unsent: 'share-used-up' };
    expect(row.first_notice_unsent).toBe('share-used-up');
  });

  it('ProductRow has test_origins_json, the TEST sites as JSON text (shyden-labs/shydesk#263)', () => {
    const row: Pick<ProductRow, 'test_origins_json'> = { test_origins_json: '[]' };
    expect(row.test_origins_json).toBe('[]');
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
