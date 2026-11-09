import type { R2Bucket } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { ticketRoutes } from '../../src/customer/ticket.ts';
import { MESSAGES } from '../../src/customer/messages.ts';
import { hashKey } from '../../src/products.ts';
import type { TimerPlan } from '../../src/tickets/status.ts';
import { standInDb } from './d1-stand-in.ts';

// The customer's private ticket page (shyden-labs/shydesk#23). The token lives
// in the link's fragment, reaches ShyDesk only in a header, and is only ever
// looked up by its hash, for the product asked about.
const ORIGIN = 'https://shytalk.app';
const TOKEN = 'the-private-token';
const product = (id: string) => ({
  id,
  name: id,
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: `${ORIGIN}/support/ticket`,
  allowed_origins_json: JSON.stringify([ORIGIN]),
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
});

async function world(
  options: {
    status?: string;
    counted?: number;
    usable?: string[];
    objects?: Record<string, string>;
    thumbType?: string;
    thumbKey?: string | null;
    usableFails?: boolean;
  } = {},
) {
  const hash = await hashKey(TOKEN);
  const ticket = { id: 't1', subject: 'It broke', status: options.status ?? 'waiting', created_at: 5 };
  const inserted: unknown[][] = [];
  const attached: unknown[][] = [];
  const plans: TimerPlan[] = [];
  const { db, statements } = standInDb((sql, v) => {
    if (sql.includes('SELECT attachments_keep_days')) return [{ attachments_keep_days: 30, text_keep_days: 365 }];
    if (sql.includes('FROM products')) return ['shytalk', 'other'].includes(String(v[0])) ? [product(String(v[0]))] : [];
    if (sql.includes('FROM tickets')) return v[0] === hash && v[1] === 'shytalk' ? [ticket] : [];
    if (sql.includes('UPDATE tickets')) return [{ product_id: 'shytalk' }];
    if (sql.includes('window_start')) return [{ value: options.counted ?? 1 }];
    if (sql.includes('INSERT INTO messages')) {
      inserted.push(v);
      return [];
    }
    if (sql.includes('UPDATE attachments')) {
      attached.push(v);
      return [];
    }
    if (sql.includes('FROM messages')) {
      return [
        { id: 'm1', author: 'customer', body: 'Help', created_at: 5, staff_email: null },
        { id: 'm2', author: 'staff', body: 'On it', created_at: 6, staff_email: 'rep@shyden.co.uk' },
      ];
    }
    if (sql.includes('FROM attachments') && sql.includes('message_id')) {
      return [
        { id: 'a1', message_id: 'm1', mime: 'image/jpeg', bytes: 10, duration_ms: null, state: 'stored', thumb_key: 'thumb-a1' },
        { id: 'a2', message_id: 'm1', mime: 'video/mp4', bytes: 20, duration_ms: 9000, state: 'deleted', thumb_key: 'thumb-a2' },
      ];
    }
    if (sql.includes('FROM attachments') && sql.includes('r2_key')) {
      return v[0] === 'a1' && v[1] === 't1'
        ? [{ r2_key: 'key-a1', thumb_key: options.thumbKey === undefined ? 'thumb-a1' : options.thumbKey, mime: 'image/jpeg' }]
        : [];
    }
    if (sql.includes('FROM attachments')) {
      if (options.usableFails === true) throw new Error('the database is away');
      return (options.usable ?? []).map((id) => ({ id }));
    }
    return [];
  });
  const objects = new Map(Object.entries(options.objects ?? { 'key-a1': 'photo bytes', 'thumb-a1': 'small' }));
  const FILES = {
    get: (key: string) =>
      Promise.resolve(
        objects.has(key) ? { body: new Response(objects.get(key)).body, httpMetadata: { contentType: options.thumbType } } : null,
      ),
  } as unknown as R2Bucket;
  const TICKET_TIMER = {
    idFromName: (name: string) => name,
    get: () => ({
      apply: (_id: string, plan: TimerPlan) => {
        plans.push(plan);
        return Promise.resolve();
      },
    }),
  };
  const app = ticketRoutes();
  const call = (path: string, init: RequestInit = {}, productId = 'shytalk', token: string | null = TOKEN) =>
    app.request(
      `${path}?product=${productId}`,
      {
        ...init,
        headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9', ...(token === null ? {} : { Authorization: `Ticket ${token}` }) },
      },
      { DB: db, FILES, TICKET_TIMER },
    );
  const reply = (body: unknown, productId = 'shytalk') =>
    call('/support-api/ticket/reply', { method: 'POST', body: JSON.stringify(body) }, productId);
  return { call, reply, inserted, attached, plans, statements };
}

describe('reading a ticket', () => {
  it('answers the thread, naming no staff member, with removed attachments marked', async () => {
    const w = await world();
    const response = await w.call('/support-api/ticket');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ticket: { subject: 'It broke', status: 'waiting', createdAt: 5 },
      messages: [
        {
          author: 'customer',
          body: 'Help',
          createdAt: 5,
          attachments: [
            { id: 'a1', mime: 'image/jpeg', bytes: 10, durationMs: null, removed: false },
            { id: 'a2', mime: 'video/mp4', bytes: 20, durationMs: 9000, removed: true },
          ],
        },
        { author: 'staff', body: 'On it', createdAt: 6, attachments: [] },
      ],
    });
  });

  it('looks the token up by its hash, never the token itself', async () => {
    const w = await world();
    await w.call('/support-api/ticket');
    const looked = w.statements.find((s) => s.sql.includes('FROM tickets'));
    expect(looked?.values).toEqual([await hashKey(TOKEN), 'shytalk']);
    expect(w.statements.flatMap((s) => s.values)).not.toContain(TOKEN);
  });

  it('is 404 for a valid token sent with another product', async () => {
    const response = await (await world()).call('/support-api/ticket', {}, 'other');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: MESSAGES.linkInvalid });
  });

  it('is 404 for an unknown token', async () => {
    expect((await (await world()).call('/support-api/ticket', {}, 'shytalk', 'nope')).status).toBe(404);
  });

  it('is 404 with no token', async () => {
    expect((await (await world()).call('/support-api/ticket', {}, 'shytalk', null)).status).toBe(404);
  });

  it('is 404 for a token in another scheme', async () => {
    expect((await standInCall(`Bearer ${TOKEN}`)).status).toBe(404);
  });

  it('is 404 with no CORS header from an origin the product does not allow', async () => {
    const w = await world();
    const response = await w.call('/support-api/ticket', {}, 'nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows the Authorization header in a preflight', async () => {
    const response = await (await world()).call('/support-api/ticket', { method: 'OPTIONS' });
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

/** A call with the whole header chosen, for a scheme other than Ticket. */
async function standInCall(header: string): Promise<Response> {
  const { db } = standInDb((sql, v) =>
    sql.includes('FROM products') ? [product(String(v[0]))] : sql.includes('FROM tickets') ? [{ id: 't1' }] : [],
  );
  return ticketRoutes().request(
    '/support-api/ticket?product=shytalk',
    { headers: { Origin: ORIGIN, Authorization: header } },
    { DB: db, FILES: {} as R2Bucket, TICKET_TIMER: {} as never },
  );
}

describe('replying', () => {
  it.each(['waiting', 'closed', 'open'])('a reply on a %s ticket leaves it open with its timers cancelled', async (status) => {
    const w = await world({ status });
    const response = await w.reply({ message: 'Still broken', attachmentIds: [] });
    expect(response.status).toBe(201);
    expect(w.inserted[0]).toEqual([expect.any(String), 't1', 'Still broken', expect.any(Number)]);
    expect(w.statements.find((s) => s.sql.includes('UPDATE tickets'))?.values[0]).toBe('open');
    expect(w.plans).toEqual([{ schedule: {}, cancel: ['autoclose', 'attachments', 'text'] }]);
  });

  it('puts usable attachments on the new message', async () => {
    const w = await world({ usable: ['a9'] });
    expect((await w.reply({ message: 'See this', attachmentIds: ['a9'] })).status).toBe(201);
    expect(w.attached[0]).toEqual(['t1', w.inserted[0]?.[0], 'a9', 'shytalk']);
  });

  it('refuses an attachment that cannot be used, saving nothing', async () => {
    const w = await world({ usable: [] });
    const response = await w.reply({ message: 'See this', attachmentIds: ['a9'] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGES.attachmentMissing });
    expect(w.inserted).toEqual([]);
    expect(w.plans).toEqual([]);
  });

  it('refuses more than 10 attachments', async () => {
    const response = await (await world()).reply({ message: 'x', attachmentIds: Array.from({ length: 11 }, (_, i) => String(i)) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MESSAGES.tooManyAttachments });
  });

  it.each([
    ['an empty message', { message: '   ', attachmentIds: [] }, MESSAGES.messageRequired],
    ['a message over 10,000 characters', { message: 'x'.repeat(10_001), attachmentIds: [] }, MESSAGES.messageTooLong],
    ['attachments that are not a list', { message: 'x', attachmentIds: 'a1' }, MESSAGES.badRequest],
    ['an attachment id that is not text', { message: 'x', attachmentIds: [1] }, MESSAGES.badRequest],
    ['a body that is not an object', [], MESSAGES.badRequest],
  ])('refuses %s', async (_name, body, error) => {
    const w = await world();
    const response = await w.reply(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(w.inserted).toEqual([]);
  });

  it('accepts a message of exactly 10,000 characters with no attachment list', async () => {
    expect((await (await world()).reply({ message: 'x'.repeat(10_000) })).status).toBe(201);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await (await world()).call('/support-api/ticket/reply', { method: 'POST', body: 'nope' });
    expect(response.status).toBe(400);
  });

  it('does not hide a database failure as a missing attachment', async () => {
    const response = await (await world({ usableFails: true })).reply({ message: 'x', attachmentIds: ['a9'] });
    expect(response.status).toBe(500);
  });

  it('admits the 20th reply in an hour from one client IP', async () => {
    expect((await (await world({ counted: 20 })).reply({ message: 'x' })).status).toBe(201);
  });

  it('refuses the 21st reply in an hour from one client IP', async () => {
    const response = await (await world({ counted: 21 })).reply({ message: 'x' });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: MESSAGES.tooMany });
  });

  it('is 404 for another product, saving nothing', async () => {
    const w = await world();
    expect((await w.reply({ message: 'x' }, 'other')).status).toBe(404);
    expect(w.inserted).toEqual([]);
  });
});

describe('fetching a file', () => {
  it("streams a stored attachment of the token's own ticket with its type", async () => {
    const response = await (await world()).call('/support-api/files/a1');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('photo bytes');
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('streams its thumbnail as a JPEG or WebP preview', async () => {
    const response = await (await world()).call('/support-api/files/a1/thumb');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('small');
  });

  it('is 404 for a thumbnail that was never sent', async () => {
    const response = await (await world({ objects: { 'key-a1': 'x' } })).call('/support-api/files/a1/thumb');
    expect(response.status).toBe(404);
  });

  it('gives a preview the type it was stored with', async () => {
    const response = await (await world({ thumbType: 'image/webp' })).call('/support-api/files/a1/thumb');
    expect(response.headers.get('Content-Type')).toBe('image/webp');
  });

  it('is 404 for the preview of an attachment that has none', async () => {
    const response = await (await world({ thumbKey: null })).call('/support-api/files/a1/thumb');
    expect(response.status).toBe(404);
  });

  it('is 404 for an attachment not on this ticket', async () => {
    expect((await (await world()).call('/support-api/files/a2')).status).toBe(404);
  });

  it('is 404 for the preview of an attachment not on this ticket', async () => {
    expect((await (await world()).call('/support-api/files/a2/thumb')).status).toBe(404);
  });

  it('is 404 when the object has gone', async () => {
    expect((await (await world({ objects: {} })).call('/support-api/files/a1')).status).toBe(404);
  });

  it('is 404 without the token', async () => {
    expect((await (await world()).call('/support-api/files/a1', {}, 'shytalk', null)).status).toBe(404);
  });
});
