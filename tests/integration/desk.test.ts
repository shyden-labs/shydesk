// The staff desk's SQL on a real D1 database with the Release 1 schema
// (shyden-labs/shydesk#24): scope, the order of the list, the unread count and
// marking read, for staff with a row and for the first admin, who has none.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Staff } from '../../src/auth/staff.ts';
import { getFile, getTicket, listTickets, markRead, unreadCount, type Scope } from '../../src/desk/queries.ts';
import { saveProduct, saveStaff, saveTicketType, supportTypeId } from '../../src/products.ts';
import { restD1 } from './d1.ts';

const asRep = (products: string[]): Scope => ({ products, role: 'rep' });
const asAdmin = (products: string[]): Scope => ({ products, role: 'admin' });

const db = restD1(inject('databaseId'));
const REP = 'desk-rep@example.com';
const rep: Staff = { email: REP, role: 'rep', products: ['desk-a'] };
const firstAdmin: Staff = { email: 'desk-first-admin@example.com', role: 'admin', products: ['desk-a', 'desk-b'] };

async function product(id: string): Promise<void> {
  await saveProduct(
    db,
    {
      id,
      name: `Product ${id}`,
      senderAddress: `no-reply@${id}.example`,
      ticketPageUrl: `https://${id}.example/ticket`,
      allowedOrigins: [`https://${id}.example`],
      monthlyEmailShare: 100,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    1000,
  );
  await saveTicketType(db, { productId: id, name: 'Support', fields: [] });
}

async function ticket(productId: string, id: string, status: string, updatedAt: number, seq: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, closed_at, seq)
       VALUES (?, ?, ?, ?, 'someone@example.com', ?, 'bug', '{}', ?, 1000, ?, NULL, ?)`,
    )
    .bind(id, productId, supportTypeId(productId), status, `Subject ${id}`, `desk-hash-${id}`, updatedAt, seq)
    .run();
}

beforeAll(async () => {
  await product('desk-a');
  await product('desk-b');
  await saveStaff(db, { email: REP, role: 'rep', products: ['desk-a'] }, 1000);
  await ticket('desk-a', 'd-waiting-old', 'waiting', 100, 1);
  await ticket('desk-a', 'd-open-new', 'open', 300, 2);
  await ticket('desk-a', 'd-open-old', 'open', 200, 3);
  await ticket('desk-a', 'd-closed', 'closed', 50, 4);
  await ticket('desk-b', 'd-theirs', 'open', 10, 5);
}, 60_000);

describe('listTickets', () => {
  it('lists waiting-on-staff tickets first, oldest first, then the rest oldest first', async () => {
    const tickets = await listTickets(db, asRep(['desk-a']), {});
    expect(tickets.map((t) => t.id)).toEqual(['d-open-old', 'd-open-new', 'd-closed', 'd-waiting-old']);
  });

  it('holds only the products asked for', async () => {
    expect((await listTickets(db, asRep(['desk-b']), {})).map((t) => t.id)).toEqual(['d-theirs']);
  });

  it('is empty for no products', async () => {
    expect(await listTickets(db, asRep([]), {})).toEqual([]);
  });

  it('filters by status and by type', async () => {
    expect((await listTickets(db, asRep(['desk-a']), { status: 'waiting' })).map((t) => t.id)).toEqual(['d-waiting-old']);
    expect(await listTickets(db, asRep(['desk-a']), { typeId: 'desk-a:no-such-type' })).toEqual([]);
    expect(await listTickets(db, asRep(['desk-a']), { typeId: supportTypeId('desk-a'), status: 'closed' })).toHaveLength(1);
  });

  it('moves on by the cursor', async () => {
    expect((await listTickets(db, asRep(['desk-a']), { cursor: 3 })).map((t) => t.id)).toEqual(['d-waiting-old']);
  });
});

describe('getTicket', () => {
  it('finds a ticket in scope, and nothing out of it', async () => {
    expect((await getTicket(db, asRep(['desk-a']), 'd-open-new'))?.ticket.subject).toBe('Subject d-open-new');
    expect(await getTicket(db, asRep(['desk-a']), 'd-theirs')).toBeNull();
    expect(await getTicket(db, asRep([]), 'd-theirs')).toBeNull();
  });

  // shyden-labs/shydesk#271 AC1: an attachment's size on the desk leaves out its thumbnail.
  it("reads each attachment's own file size, without its thumbnail", async () => {
    await db
      .prepare(
        "INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES ('d-msg-size', 'd-closed', 'customer', NULL, 'Hi', 1000)",
      )
      .run();
    await db
      .prepare(
        `INSERT INTO attachments (id, product_id, ticket_id, message_id, r2_key, thumb_key, mime, bytes, thumb_bytes, state, created_at)
         VALUES ('d-att-size', 'desk-a', 'd-closed', 'd-msg-size', 'key-d-att-size', 'thumb-d-att-size', 'image/jpeg', 21046, 7183, 'stored', 1000)`,
      )
      .run();
    const found = await getTicket(db, asRep(['desk-a']), 'd-closed');
    expect(found?.attachments.map((a) => ({ id: a.id, file_bytes: a.file_bytes }))).toEqual([{ id: 'd-att-size', file_bytes: 13_863 }]);
  });
});

describe('getFile', () => {
  // shyden-labs/shydesk#25 AC2: staff read a file only when it is stored on a ticket in their scope.
  beforeAll(async () => {
    const add = (id: string, productId: string, ticketId: string | null, state: string) =>
      db
        .prepare(
          `INSERT INTO attachments (id, product_id, ticket_id, message_id, r2_key, thumb_key, mime, bytes, state, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 'image/jpeg', 10, ?, 1000)`,
        )
        .bind(id, productId, ticketId, `key-${id}`, `thumb-${id}`, state)
        .run();
    await add('df-stored', 'desk-a', 'd-open-new', 'stored');
    await add('df-deleted', 'desk-a', 'd-open-new', 'deleted');
    await add('df-pending', 'desk-a', null, 'pending');
    await add('df-theirs', 'desk-b', 'd-theirs', 'stored');
  }, 60_000);

  it('finds a stored file on a ticket in scope, with its keys and type', async () => {
    expect(await getFile(db, asRep(['desk-a']), 'df-stored')).toEqual({
      r2_key: 'key-df-stored',
      thumb_key: 'thumb-df-stored',
      mime: 'image/jpeg',
    });
  });

  it('finds nothing removed, still uploading, or on another product, nor anything for no products', async () => {
    expect(await getFile(db, asRep(['desk-a']), 'df-deleted')).toBeNull();
    expect(await getFile(db, asRep(['desk-a']), 'df-pending')).toBeNull();
    expect(await getFile(db, asRep(['desk-a']), 'df-theirs')).toBeNull();
    expect(await getFile(db, asRep([]), 'df-stored')).toBeNull();
  });
});

describe('unread', () => {
  it('counts tickets waiting on staff in scope that this person has not seen since they changed', async () => {
    expect(await unreadCount(db, REP, asRep(['desk-a']))).toBe(2);
    await markRead(db, rep, 'd-open-new');
    expect(await unreadCount(db, REP, asRep(['desk-a']))).toBe(1);
  });

  it('counts a ticket again once it changes after being read', async () => {
    await markRead(db, rep, 'd-open-old');
    expect(await unreadCount(db, REP, asRep(['desk-a']))).toBe(0);
    await db.prepare('UPDATE tickets SET seq = 99 WHERE id = ?').bind('d-open-old').run();
    expect(await unreadCount(db, REP, asRep(['desk-a']))).toBe(1);
  });

  it('is 0 for no products', async () => {
    expect(await unreadCount(db, REP, asRep([]))).toBe(0);
  });

  it('never counts another product', async () => {
    expect(await unreadCount(db, REP, asRep(['desk-b']))).toBe(1);
    // Others' reads count for nothing: both open tickets are still unread for someone who has opened none.
    expect(await unreadCount(db, 'desk-other@example.com', asRep(['desk-a']))).toBe(2);
  });

  it('marks read for the first admin, who has no staff row', async () => {
    const before = await unreadCount(db, firstAdmin.email, asAdmin(['desk-b']));
    expect(before).toBe(1);
    await markRead(db, firstAdmin, 'd-theirs');
    expect(await unreadCount(db, firstAdmin.email, asAdmin(['desk-b']))).toBe(0);
    const row = await db.prepare('SELECT role FROM staff WHERE email = ?').bind(firstAdmin.email).first<{ role: string }>();
    expect(row?.role).toBe('admin');
  });
});

// shyden-labs/shydesk#232: a bounced notice on real D1 shows with its ticket, and the list marks the ticket only
// while its latest notice bounced.
describe('bounced notices', () => {
  it('reads the bounced notice with the ticket and marks the list until a later notice is sent fine', async () => {
    await db
      .prepare(
        "INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES ('d-bm1', 'd-open-old', 'staff', ?, 'Fixed', 1000)",
      )
      .bind(REP)
      .run();
    await db
      .prepare(
        `INSERT INTO notices (id, ticket_id, message_id, to_address, sent_at, bounced_at, bounce_status, bounce_reason)
         VALUES ('d-n1', 'd-open-old', 'd-bm1', 'someone@example.com', 2000, 2100, '5.1.1', '550 5.1.1 user unknown'),
                ('d-n0', 'd-open-old', NULL, 'someone@example.com', 1000, NULL, NULL, NULL)`,
      )
      .run();
    const found = await getTicket(db, asRep(['desk-a']), 'd-open-old');
    expect.soft(found?.notices).toEqual([
      {
        message_id: 'd-bm1',
        to_address: 'someone@example.com',
        bounced_at: 2100,
        bounce_status: '5.1.1',
        bounce_reason: '550 5.1.1 user unknown',
      },
    ]);
    const marked = (rows: Awaited<ReturnType<typeof listTickets>>) => rows.find((t) => t.id === 'd-open-old')?.last_notice_bounced;
    expect.soft(marked(await listTickets(db, asRep(['desk-a']), {}))).toBe(1);
    expect.soft((await listTickets(db, asRep(['desk-a']), {})).find((t) => t.id === 'd-open-new')?.last_notice_bounced).toBe(0);
    await db
      .prepare(
        "INSERT INTO notices (id, ticket_id, message_id, to_address, sent_at) VALUES ('d-n2', 'd-open-old', NULL, 'someone@example.com', 3000)",
      )
      .run();
    expect.soft(marked(await listTickets(db, asRep(['desk-a']), {}))).toBe(0);
  });
});
