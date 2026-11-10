// Ticket timers' SQL on a real D1 database with the Release 1 schema
// (shyden-labs/shydesk#22): a status change moves the ticket to the next feed
// seq and only from the expected status; retention deletes only while the
// ticket is closed; the overdue panel lists exactly what is past due. R2 is not
// enabled yet (shyden-labs/shydesk#35), so object deletes go to a recorder.
import { describe, expect, inject, it } from 'vitest';
import { overdue } from '../../src/desk/overdue.ts';
import { saveProduct, saveTicketType, supportTypeId } from '../../src/products.ts';
import { STORED_BYTES, storedBytes } from '../../src/storage.ts';
import { DAY_MS, writeStatus } from '../../src/tickets/status.ts';
import { deleteAttachments, deleteText } from '../../src/timers/retention.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const NOW = Date.UTC(2026, 10, 6, 12);

async function product(id: string, attachmentsKeepDays = 30, textKeepDays = 365): Promise<void> {
  await saveProduct(
    db,
    {
      id,
      name: `Product ${id}`,
      senderAddress: `no-reply@${id}.example`,
      ticketPageUrl: `https://${id}.example/ticket`,
      allowedOrigins: [`https://${id}.example`],
      monthlyEmailShare: 100,
      attachmentsKeepDays,
      textKeepDays,
    },
    1000,
  );
  await saveTicketType(db, { productId: id, name: 'Support', fields: [] });
}

async function ticket(productId: string, id: string, status: string, updatedAt: number, closedAt: number | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, closed_at, seq)
       VALUES (?, ?, ?, ?, 'someone@example.com', 'Subject', 'bug', '{}', ?, 1000, ?, ?, 0)`,
    )
    .bind(id, productId, supportTypeId(productId), status, `hash-${id}`, updatedAt, closedAt)
    .run();
}

async function attachment(
  productId: string,
  id: string,
  ticketId: string | null,
  state: string,
  bytes: number,
  createdAt = 1000,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attachments (id, product_id, ticket_id, r2_key, thumb_key, mime, bytes, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, ?, ?)`,
    )
    .bind(id, productId, ticketId, `k-${id}`, `th-${id}`, bytes, state, createdAt)
    .run();
}

/** A rep who has opened the ticket, as the desk records it (src/desk/queries.ts). */
const staffRead = async (email: string, ticketId: string) => {
  await db.prepare(`INSERT INTO staff (email, role, created_at) VALUES (?, 'rep', 1000)`).bind(email).run();
  await db.prepare(`INSERT INTO reads (email, ticket_id, read_seq) VALUES (?, ?, 1)`).bind(email, ticketId).run();
};

const one = async (sql: string, ...values: unknown[]) =>
  db
    .prepare(sql)
    .bind(...values)
    .first();

function recorder() {
  const deleted: string[][] = [];
  return {
    deleted,
    files: {
      delete: (keys: string | string[]) => {
        deleted.push([keys].flat());
        return Promise.resolve();
      },
    },
  };
}

describe('writeStatus on D1', () => {
  it('closes a ticket at the next feed seq and returns its keep-days', async () => {
    await product('it-tm-status', 2, 3);
    await ticket('it-tm-status', 'it-tm-s1', 'open', 1000, null);
    const before = (await one(`SELECT value FROM counters WHERE key = 'feed_seq'`))?.value ?? 0;
    expect(await writeStatus(db, 'it-tm-s1', 'closed', NOW)).toEqual({ attachmentsKeepDays: 2, textKeepDays: 3 });
    const row = await one('SELECT status, updated_at, closed_at, seq FROM tickets WHERE id = ?', 'it-tm-s1');
    expect(row).toMatchObject({ status: 'closed', updated_at: NOW, closed_at: NOW });
    expect(row?.seq).toBe(Number(before) + 1);
  });

  it('leaves a ticket not in the expected status alone', async () => {
    await product('it-tm-from');
    await ticket('it-tm-from', 'it-tm-f1', 'open', 1000, null);
    expect(await writeStatus(db, 'it-tm-f1', 'closed', NOW, 'waiting')).toBeNull();
    expect(await one('SELECT status FROM tickets WHERE id = ?', 'it-tm-f1')).toEqual({ status: 'open' });
  });
});

describe('retention on D1', () => {
  it('deletes a closed ticket’s stored attachments and takes their bytes off the total', async () => {
    await product('it-tm-att');
    await ticket('it-tm-att', 'it-tm-a1', 'closed', 1000, 1000);
    await attachment('it-tm-att', 'it-tm-x1', 'it-tm-a1', 'stored', 100);
    await attachment('it-tm-att', 'it-tm-x2', 'it-tm-a1', 'stored', 50);
    await db
      .prepare(`INSERT INTO counters (key, value) VALUES (?, 150) ON CONFLICT (key) DO UPDATE SET value = value + 150`)
      .bind(STORED_BYTES)
      .run();
    const before = await storedBytes(db);
    const { deleted, files } = recorder();
    await deleteAttachments(db, files, 'it-tm-a1', NOW);
    expect(deleted.flat().sort()).toEqual(['k-it-tm-x1', 'k-it-tm-x2', 'th-it-tm-x1', 'th-it-tm-x2']);
    expect(
      await one(`SELECT COUNT(*) AS n FROM attachments WHERE ticket_id = ? AND state = 'deleted' AND deleted_at = ?`, 'it-tm-a1', NOW),
    ).toEqual({ n: 2 });
    expect(await storedBytes(db)).toBe(before - 150);
  });

  it('leaves a reopened ticket’s attachments and text alone', async () => {
    await product('it-tm-open');
    await ticket('it-tm-open', 'it-tm-o1', 'open', 1000, null);
    await attachment('it-tm-open', 'it-tm-y1', 'it-tm-o1', 'stored', 10);
    await staffRead('it-tm-rep-o@example.com', 'it-tm-o1');
    const { deleted, files } = recorder();
    await deleteText(db, files, 'it-tm-o1', NOW);
    expect(deleted).toEqual([]);
    expect(await one('SELECT read_seq FROM reads WHERE ticket_id = ?', 'it-tm-o1')).toEqual({ read_seq: 1 });
    expect(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-y1')).toEqual({ state: 'stored' });
    expect(await one('SELECT status FROM tickets WHERE id = ?', 'it-tm-o1')).toEqual({ status: 'open' });
  });

  // A ticket staff have opened carries their read marks, which reference it (shyden-labs/shydesk#119).
  it('deletes a closed ticket’s text: its attachments, messages, staff read marks and the ticket', async () => {
    await product('it-tm-text');
    await ticket('it-tm-text', 'it-tm-t1', 'closed', 1000, 1000);
    await db
      .prepare(`INSERT INTO messages (id, ticket_id, author, body, created_at) VALUES ('it-tm-m1', 'it-tm-t1', 'customer', 'Hello', 1000)`)
      .run();
    await attachment('it-tm-text', 'it-tm-z1', 'it-tm-t1', 'deleted', 5);
    await staffRead('it-tm-rep-t@example.com', 'it-tm-t1');
    await deleteText(db, recorder().files, 'it-tm-t1', NOW);
    expect(await one('SELECT id FROM tickets WHERE id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT id FROM messages WHERE ticket_id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT id FROM attachments WHERE ticket_id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT email FROM reads WHERE ticket_id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT email FROM staff WHERE email = ?', 'it-tm-rep-t@example.com')).toEqual({ email: 'it-tm-rep-t@example.com' });
  });
});

describe('overdue on D1', () => {
  it('lists exactly what is past its due date, and nothing not yet due', async () => {
    await product('it-tm-due', 30, 365);
    // Closed 31 days ago: attachments past due, text not.
    await ticket('it-tm-due', 'it-tm-d1', 'closed', NOW - 31 * DAY_MS, NOW - 31 * DAY_MS);
    await attachment('it-tm-due', 'it-tm-d1-a', 'it-tm-d1', 'stored', 1);
    // Closed 29 days ago: nothing due yet.
    await ticket('it-tm-due', 'it-tm-d2', 'closed', NOW - 29 * DAY_MS, NOW - 29 * DAY_MS);
    await attachment('it-tm-due', 'it-tm-d2-a', 'it-tm-d2', 'stored', 1);
    // Closed 366 days ago: text past due.
    await ticket('it-tm-due', 'it-tm-d3', 'closed', NOW - 366 * DAY_MS, NOW - 366 * DAY_MS);
    // Waiting 8 days: auto-close past due; waiting 6 days: not.
    await ticket('it-tm-due', 'it-tm-d4', 'waiting', NOW - 8 * DAY_MS, null);
    await ticket('it-tm-due', 'it-tm-d5', 'waiting', NOW - 6 * DAY_MS, null);
    // An upload pending 2 hours: past due; 30 minutes: not.
    await attachment('it-tm-due', 'it-tm-u1', null, 'pending', 1, NOW - 2 * 3_600_000);
    await attachment('it-tm-due', 'it-tm-u2', null, 'pending', 1, NOW - 1_800_000);
    await attachment('it-tm-due', 'it-tm-o1', null, 'stored', 1, NOW - 2 * DAY_MS);
    await attachment('it-tm-due', 'it-tm-o2', null, 'stored', 1, NOW - 3_600_000);

    const mine = (await overdue(db, NOW)).filter((o) => o.productId === 'it-tm-due');
    expect(mine).toHaveLength(5);
    expect(mine).toEqual(
      expect.arrayContaining([
        { kind: 'text', id: 'it-tm-d3', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
        { kind: 'autoclose', id: 'it-tm-d4', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
        { kind: 'attachment', id: 'it-tm-d1-a', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
        { kind: 'unattached', id: 'it-tm-o1', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
      ]),
    );
    // Oldest due first: the upload, due an hour ago, comes last.
    expect(mine.at(-1)).toEqual({ kind: 'upload', id: 'it-tm-u1', productId: 'it-tm-due', dueAt: NOW - 3_600_000 });
  });
});
