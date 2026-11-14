// The customer ticket page's SQL on a real D1 database with the Release 1 schema
// (shyden-labs/shydesk#23): a token opens only its own product's ticket, a thread
// leaves out unfinished uploads, a reply reopens the ticket and takes only
// attachments it may use, and a file is served only while stored on that ticket.
// R2 and the timer's Durable Object go to stand-ins: only the SQL is under test.
import type { R2Bucket } from '@cloudflare/workers-types';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { ticketRoutes, type TicketBindings } from '../../src/customer/ticket.ts';
import { hashKey, saveProduct, saveTicketType, supportTypeId } from '../../src/products.ts';
import type { TimerPlan } from '../../src/tickets/status.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const plans: TimerPlan[] = [];
const FILES = {
  get: (key: string) => Promise.resolve({ body: new Response(`bytes of ${key}`).body, httpMetadata: { contentType: 'image/webp' } }),
} as unknown as R2Bucket;
const TICKET_TIMER = {
  idFromName: (name: string) => name,
  get: () => ({
    apply: (_id: string, plan: TimerPlan) => {
      plans.push(plan);
      return Promise.resolve();
    },
  }),
} as unknown as TicketBindings['TICKET_TIMER'];

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
      privacyPolicyUrlEn: 'https://example.com/privacy',
      privacyPolicyUrlId: 'https://example.com/id/privacy',
    },
    1000,
  );
  await saveTicketType(db, { productId: id, name: 'Support', fields: [] });
}

async function ticket(productId: string, id: string, status: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, closed_at, seq)
       VALUES (?, ?, ?, ?, 'someone@example.com', 'Subject', 'bug', '{}', ?, 1000, 1000, ?, 0)`,
    )
    .bind(id, productId, supportTypeId(productId), status, await hashKey(`token-${id}`), status === 'closed' ? 1000 : null)
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES (?, ?, 'customer', NULL, 'First words', 1000)",
    )
    .bind(`first-${id}`, id)
    .run();
}

async function attachment(id: string, productId: string, state: string, ticketId: string | null, messageId: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attachments (id, product_id, ticket_id, message_id, r2_key, thumb_key, mime, bytes, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', 10, ?, 1000)`,
    )
    .bind(id, productId, ticketId, messageId, `key-${id}`, `thumb-${id}`, state)
    .run();
}

/** A call from the product's own page, carrying the ticket's token. */
function call(path: string, productId: string, ticketId: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(
    ticketRoutes().request(
      `${path}?product=${productId}`,
      {
        ...init,
        headers: {
          Origin: `https://${productId}.example`,
          'CF-Connecting-IP': `203.0.113.${ticketId.length}`,
          Authorization: `Ticket token-${ticketId}`,
        },
      },
      { DB: db, FILES, TICKET_TIMER },
    ),
  );
}

const reply = (ticketId: string, attachmentIds: string[]): Promise<Response> =>
  call('/support-api/ticket/reply', 'ticket-a', ticketId, {
    method: 'POST',
    body: JSON.stringify({ message: 'Still broken', attachmentIds }),
  });

async function statusOf(id: string): Promise<{ status: string; closed_at: number | null; seq: number }> {
  const row = await db
    .prepare('SELECT status, closed_at, seq FROM tickets WHERE id = ?')
    .bind(id)
    .first<{ status: string; closed_at: number | null; seq: number }>();
  if (row === null) throw new Error(`no ticket ${id}`);
  return row;
}

async function messageCount(id: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE ticket_id = ?').bind(id).first<{ n: number }>())?.n ?? -1;
}

beforeAll(async () => {
  await product('ticket-a');
  await product('ticket-b');
}, 60_000);

describe('the token', () => {
  it('opens its own ticket, and is 404 sent with another product', async () => {
    await ticket('ticket-a', 'tok', 'open');
    expect((await call('/support-api/ticket', 'ticket-a', 'tok')).status).toBe(200);
    expect((await call('/support-api/ticket', 'ticket-b', 'tok')).status).toBe(404);
  });
});

describe('the thread', () => {
  it('holds stored and removed attachments, never an unfinished upload', async () => {
    await ticket('ticket-a', 'thread', 'open');
    await attachment('t-stored', 'ticket-a', 'stored', 'thread', 'first-thread');
    await attachment('t-deleted', 'ticket-a', 'deleted', 'thread', 'first-thread');
    await attachment('t-pending', 'ticket-a', 'pending', 'thread', 'first-thread');
    const body = (await (await call('/support-api/ticket', 'ticket-a', 'thread')).json()) as {
      messages: { body: string; attachments: { id: string; removed: boolean }[] }[];
    };
    expect(body.messages.map((m) => m.body)).toEqual(['First words']);
    const seen = Object.fromEntries((body.messages[0]?.attachments ?? []).map((a) => [a.id, a.removed]));
    expect(seen).toEqual({ 't-stored': false, 't-deleted': true });
  });
});

describe('a reply', () => {
  it('reopens a closed ticket, moves it along the feed and saves the message', async () => {
    await ticket('ticket-a', 'closed', 'closed');
    plans.length = 0;
    const before = await statusOf('closed');
    expect((await reply('closed', [])).status).toBe(201);
    const after = await statusOf('closed');
    expect(after.status).toBe('open');
    expect(after.closed_at).toBeNull();
    expect(after.seq).toBeGreaterThan(before.seq);
    expect(await messageCount('closed')).toBe(2);
    expect(plans).toEqual([{ schedule: {}, cancel: ['autoclose', 'attachments', 'text'] }]);
  });

  it('puts a stored upload of this product on the new message', async () => {
    await ticket('ticket-a', 'usable', 'waiting');
    await attachment('u-free', 'ticket-a', 'stored', null, null);
    expect((await reply('usable', ['u-free'])).status).toBe(201);
    const row = await db
      .prepare('SELECT ticket_id, message_id FROM attachments WHERE id = ?')
      .bind('u-free')
      .first<{ ticket_id: string; message_id: string }>();
    expect(row?.ticket_id).toBe('usable');
    expect(row?.message_id).not.toBe('first-usable');
    expect(row?.message_id).toEqual(expect.any(String));
  });

  it.each([
    ['of another product', 'r-other', 'ticket-b', 'stored', null, null],
    ['still uploading', 'r-pending', 'ticket-a', 'pending', null, null],
    ['already on a ticket', 'r-taken', 'ticket-a', 'stored', 'taken', 'first-taken'],
  ])('refuses an attachment %s, saving nothing', async (_name, id, owner, state, onTicket, onMessage) => {
    const replying = `refuse-${id}`;
    await ticket('ticket-a', replying, 'waiting');
    if (onTicket !== null) await ticket('ticket-a', onTicket, 'open');
    await attachment(id, owner, state, onTicket, onMessage);
    expect((await reply(replying, [id])).status).toBe(400);
    expect(await messageCount(replying)).toBe(1);
    expect((await statusOf(replying)).status).toBe('waiting');
    const row = await db.prepare('SELECT ticket_id FROM attachments WHERE id = ?').bind(id).first<{ ticket_id: string | null }>();
    expect(row?.ticket_id).toBe(onTicket);
  });
});

describe('a file', () => {
  it('is served while stored on this ticket, with its preview in the type it was stored as', async () => {
    await ticket('ticket-a', 'files', 'open');
    await attachment('f-stored', 'ticket-a', 'stored', 'files', 'first-files');
    const file = await call('/support-api/files/f-stored', 'ticket-a', 'files');
    expect(await file.text()).toBe('bytes of key-f-stored');
    expect(file.headers.get('Content-Type')).toBe('image/jpeg');
    const preview = await call('/support-api/files/f-stored/thumb', 'ticket-a', 'files');
    expect(await preview.text()).toBe('bytes of thumb-f-stored');
    expect(preview.headers.get('Content-Type')).toBe('image/webp');
  });

  it('is 404 once removed, and on another ticket', async () => {
    await ticket('ticket-a', 'files2', 'open');
    await ticket('ticket-a', 'files3', 'open');
    await attachment('f-removed', 'ticket-a', 'deleted', 'files2', 'first-files2');
    await attachment('f-theirs', 'ticket-a', 'stored', 'files3', 'first-files3');
    expect((await call('/support-api/files/f-removed', 'ticket-a', 'files2')).status).toBe(404);
    expect((await call('/support-api/files/f-theirs', 'ticket-a', 'files2')).status).toBe(404);
  });
});
