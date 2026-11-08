// The Release 1 schema on a real D1 database (shyden-labs/shydesk#15): every
// table and index the plan lists exists, and the CHECK constraints refuse a
// value outside their set while the same row with an allowed value is kept.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { query } from './d1.ts';

const db = inject('databaseId');

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const [statement] = await query(db, sql, params);
  return statement?.results ?? [];
}

async function columnsOf(table: string): Promise<string[]> {
  return (await rows(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table])).map((r) => String(r.name));
}

async function indexColumns(table: string): Promise<string[][]> {
  const indexes = await rows(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, [table]);
  return Promise.all(
    indexes.map(async (i) => (await rows(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, [i.name])).map((r) => String(r.name))),
  );
}

describe('tables', () => {
  it('products', async () => {
    expect(await columnsOf('products')).toEqual([
      'id',
      'name',
      'sender_address',
      'ticket_page_url',
      'allowed_origins_json',
      'monthly_email_share',
      'attachments_keep_days',
      'text_keep_days',
      'created_at',
    ]);
  });
  it('ticket_types', async () => {
    expect(await columnsOf('ticket_types')).toEqual(['id', 'product_id', 'kind', 'name', 'fields_json', 'reasons_json', 'enabled']);
  });
  it('staff', async () => {
    expect(await columnsOf('staff')).toEqual(['email', 'role', 'created_at']);
  });
  it('staff_products', async () => {
    expect(await columnsOf('staff_products')).toEqual(['email', 'product_id']);
  });
  it('tickets', async () => {
    expect(await columnsOf('tickets')).toEqual([
      'id',
      'product_id',
      'type_id',
      'status',
      'customer_email',
      'subject',
      'category',
      'fields_json',
      'token_hash',
      'created_at',
      'updated_at',
      'closed_at',
      'seq',
    ]);
  });
  it('messages', async () => {
    expect(await columnsOf('messages')).toEqual(['id', 'ticket_id', 'author', 'staff_email', 'body', 'created_at']);
  });
  it('attachments', async () => {
    expect(await columnsOf('attachments')).toEqual([
      'id',
      'product_id',
      'ticket_id',
      'message_id',
      'r2_key',
      'r2_upload_id',
      'thumb_key',
      'mime',
      'bytes',
      'duration_ms',
      'state',
      'created_at',
      'deleted_at',
      'received_bytes',
    ]);
  });
  it('canned_replies', async () => {
    expect(await columnsOf('canned_replies')).toEqual(['id', 'product_id', 'type_id', 'name', 'body']);
  });
  it('api_keys', async () => {
    expect(await columnsOf('api_keys')).toEqual(['hash', 'product_id', 'label', 'created_at', 'revoked_at']);
  });
  it('counters', async () => {
    expect(await columnsOf('counters')).toEqual(['key', 'value', 'window_start']);
  });
  it('reads', async () => {
    expect(await columnsOf('reads')).toEqual(['email', 'ticket_id', 'read_seq']);
  });
});

describe('indexes', () => {
  it('lists tickets by product, status and last change', async () => {
    expect(await indexColumns('tickets')).toContainEqual(['product_id', 'status', 'updated_at']);
  });
  it('feeds tickets by product and sequence', async () => {
    expect(await indexColumns('tickets')).toContainEqual(['product_id', 'seq']);
  });
});

describe('CHECK constraints', () => {
  beforeAll(async () => {
    await query(
      db,
      `INSERT INTO products (id, name, sender_address, ticket_page_url, allowed_origins_json, monthly_email_share, created_at)
         VALUES ('p1', 'Product', 'no-reply@example.test', 'https://example.test/support', '[]', 100, 0);
       INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled)
         VALUES ('t1', 'p1', 'support', 'Help', '[]', '[]', 1);`,
    );
  });

  const ticket = (id: string, status: string) =>
    query(
      db,
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq)
         VALUES (?, 'p1', 't1', ?, 'a@example.test', 'Subject', 'general', '{}', ?, 0, 0, 1)`,
      [id, status, `hash-${id}`],
    );
  const staff = (email: string, role: string) => query(db, `INSERT INTO staff (email, role, created_at) VALUES (?, ?, 0)`, [email, role]);

  it('keeps a ticket whose status is open', async () => {
    await ticket('k1', 'open');
    expect(await rows(`SELECT status FROM tickets WHERE id = 'k1'`)).toEqual([{ status: 'open' }]);
  });
  it('refuses a ticket whose status is not open, waiting or closed', async () => {
    await expect(ticket('k2', 'pending')).rejects.toThrow(/CHECK constraint failed/);
  });
  it('keeps a staff member whose role is rep', async () => {
    await staff('rep@example.test', 'rep');
    expect(await rows(`SELECT role FROM staff WHERE email = 'rep@example.test'`)).toEqual([{ role: 'rep' }]);
  });
  it('refuses a staff member whose role is not admin or rep', async () => {
    await expect(staff('owner@example.test', 'owner')).rejects.toThrow(/CHECK constraint failed/);
  });
});
