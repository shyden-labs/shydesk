import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { deskRoutes, type DeskBindings } from '../../src/desk/routes.ts';
import { fillCanned } from '../../src/desk/queries.ts';
import type { SmtpLogin, SmtpMail } from '../../src/mail/smtp.ts';
import { sealToken } from '../../src/tickets/seal.ts';
import type { TimerPlan } from '../../src/tickets/status.ts';
import { standInDb, type Statement } from './d1-stand-in.ts';

// The staff desk (shyden-labs/shydesk#24) on a D1 stand-in: who may reach what, and
// what each action writes and sends. The SQL itself is proven in tests/integration/desk.test.ts.
const TEAM = 'shydesk-test.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-desk';
const ADMIN = 'admin@example.com';
const REP = 'rep@example.com';
const ORIGIN = 'http://localhost';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let jwks: JWTVerifyGetKey;
let sign: (email: string) => Promise<string>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
  sign = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setAudience(AUD)
      .setIssuer(`https://${TEAM}`)
      .setExpirationTime('5m')
      .sign(pair.privateKey);
});

const productRow = (id: string) => ({
  id,
  name: `Product ${id}`,
  sender_address: `no-reply@${id}.example`,
  ticket_page_url: `https://${id}.example/ticket`,
  allowed_origins_json: JSON.stringify([`https://${id}.example`]),
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
});

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  product_id: 'shytalk',
  type_id: 'shytalk:support',
  status: 'open',
  customer_email: 'ana@example.com',
  subject: 'Cannot <b>sign</b> in',
  category: 'account',
  fields_json: '{"Device":"Pixel"}',
  created_at: 5,
  updated_at: 6,
  seq: 3,
  token_sealed: null,
  ...over,
});

interface World {
  tickets?: Record<string, unknown>[];
  unread?: number;
  mailFails?: boolean;
  mailShareUsed?: boolean;
  noTokenKey?: boolean;
  productGone?: boolean;
  /** Rows the scoped file lookup answers; none means out of scope or not stored. */
  files?: Record<string, unknown>[];
  /** The stored bytes by key, with the type each was stored with. */
  objects?: Record<string, { body: string; type?: string }>;
  attachments?: Record<string, unknown>[];
}

function setup(w: World = {}) {
  const tickets = w.tickets ?? [ticketRow()];
  const plans: TimerPlan[] = [];
  const mails: SmtpMail[] = [];
  const { db, statements } = standInDb((sql, values) => {
    if (/SELECT attachments_keep_days/.test(sql)) return [{ attachments_keep_days: 30, text_keep_days: 365 }];
    if (/FROM products WHERE id = \?/.test(sql)) return w.productGone === true ? [] : [productRow(String(values[0]))];
    if (/FROM products/.test(sql)) return [productRow('shytalk'), productRow('yawelo-idle')];
    if (/FROM staff_products/.test(sql)) return values[0] === REP ? [{ product_id: 'shytalk' }] : [];
    if (/FROM staff WHERE/.test(sql)) return values[0] === REP ? [{ role: 'rep' }] : [];
    if (/UPDATE tickets/.test(sql)) return [{ product_id: 'shytalk' }];
    if (/COUNT\(\*\)/.test(sql)) return [{ unread: w.unread ?? 0 }];
    if (/INTO counters/.test(sql)) return w.mailShareUsed === true ? [] : [{ value: 1 }];
    if (/FROM canned_replies/.test(sql)) {
      return [
        { id: 'c1', type_id: null, name: 'Thanks', body: 'Hello {{customer_email}}, about {{ticket_subject}}.' },
        { id: 'c2', type_id: 'other:type', name: 'Other type', body: 'Not for this ticket' },
      ];
    }
    if (/FROM ticket_types/.test(sql))
      return [
        {
          id: 'shytalk:support',
          product_id: 'shytalk',
          kind: 'support',
          name: 'Support',
          fields_json: '[]',
          reasons_json: '[]',
          enabled: 1,
        },
      ];
    if (/FROM messages/.test(sql)) {
      return [
        { id: 'm1', author: 'customer', staff_email: null, body: 'Help <script>', created_at: 5 },
        { id: 'm2', author: 'staff', staff_email: REP, body: 'On it', created_at: 6 },
      ];
    }
    if (/FROM attachments a JOIN tickets/.test(sql)) return w.files ?? [{ r2_key: 'key-a2', thumb_key: 'thumb-a2', mime: 'video/mp4' }];
    if (/FROM attachments/.test(sql))
      return w.attachments ?? [{ id: 'a1', message_id: 'm1', mime: 'image/jpeg', bytes: 2000, duration_ms: null, state: 'deleted' }];
    if (/FROM tickets/.test(sql)) return tickets;
    return [];
  });
  const TICKET_TIMER = {
    idFromName: (name: string) => name,
    get: () => ({
      apply: (_id: string, plan: TimerPlan) => {
        plans.push(plan);
        return Promise.resolve();
      },
    }),
  };
  const env = {
    DB: db,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    FIRST_ADMIN_EMAIL: ADMIN,
    TICKET_TIMER,
    SMTP_LOGINS: JSON.stringify({ 'no-reply@shytalk.example': { user: 'u', pass: 'p' } }),
    ...(w.noTokenKey === true ? {} : { TICKET_TOKEN_KEY: KEY }),
    FILES: {
      get: (key: string) => {
        const object = (w.objects ?? { 'key-a2': { body: 'video bytes' }, 'thumb-a2': { body: 'small', type: 'image/webp' } })[key];
        return Promise.resolve(
          object === undefined ? null : { body: new Response(object.body).body, httpMetadata: { contentType: object.type } },
        );
      },
    },
    ASSETS: { fetch: () => Promise.resolve(new Response('/* desk */', { headers: { 'Content-Type': 'text/javascript' } })) },
  } as unknown as DeskBindings;
  const app = deskRoutes(
    {
      deliver: (_login: SmtpLogin, mail: SmtpMail) => {
        if (w.mailFails === true) return Promise.reject(new Error('550 refused'));
        mails.push(mail);
        return Promise.resolve();
      },
    },
    jwks,
  );
  const get = async (path: string, who = REP, method = 'GET') =>
    app.request(path, { method, headers: { 'Cf-Access-Jwt-Assertion': await sign(who), Origin: ORIGIN } }, env);
  const post = async (path: string, form: Record<string, string> = {}, who = REP, origin = ORIGIN) =>
    app.request(
      path,
      {
        method: 'POST',
        body: new URLSearchParams(form),
        headers: { 'Cf-Access-Jwt-Assertion': await sign(who), 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      },
      env,
    );
  return { app, env, get, post, plans, mails, statements };
}

const named = (statements: Statement[], text: string) => statements.filter((s) => s.sql.includes(text));

describe('who may reach the desk', () => {
  it('is 401 with no Access token', async () => {
    const { app, env } = setup();
    expect((await app.request('/desk', {}, env)).status).toBe(401);
  });

  it('is 403 for someone Access let in who is not staff', async () => {
    expect((await setup().get('/desk', 'stranger@example.com')).status).toBe(403);
  });
});

describe('the ticket list', () => {
  it('lists the tickets of the products in scope', async () => {
    const { get, statements } = setup();
    const page = await (await get('/desk')).text();
    expect(page).toContain('Cannot &lt;b&gt;sign&lt;/b&gt; in');
    expect(named(statements, 'FROM tickets')[0]?.values).toContain('shytalk');
  });

  it("gives a rep an empty list for another product's filter, asking the database nothing", async () => {
    const { get, statements } = setup();
    const response = await get('/desk?product=yawelo-idle');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('Cannot');
    expect(named(statements, 'FROM tickets')).toEqual([]);
  });

  it('shows a rep only granted products in the switcher, and no "All products"', async () => {
    const page = await (await setup().get('/desk')).text();
    expect(page).toContain('Product shytalk');
    expect(page).not.toContain('Product yawelo-idle');
    expect(page).not.toContain('All products');
  });

  it('shows an admin every product and "All products"', async () => {
    const page = await (await setup().get('/desk', ADMIN)).text();
    expect(page).toContain('Product yawelo-idle');
    expect(page).toContain('All products');
  });

  it('passes the status and type filters on', async () => {
    const { get, statements } = setup();
    await get('/desk?status=waiting&type=shytalk%3Asupport');
    const values = named(statements, 'FROM tickets')[0]?.values;
    expect(values).toContain('waiting');
    expect(values).toContain('shytalk:support');
  });

  it('ignores a status that does not exist', async () => {
    const { get, statements } = setup();
    expect((await get('/desk?status=nonsense')).status).toBe(200);
    expect(named(statements, 'FROM tickets')[0]?.values).not.toContain('nonsense');
  });

  it('links on to the next page only when a full page came back', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ticketRow({ id: `t${String(i)}` }));
    expect(await (await setup({ tickets: full }).get('/desk?status=open')).text()).toContain('cursor=50');
    expect(await (await setup().get('/desk')).text()).not.toContain('cursor=');
  });

  it('reads a page number from the cursor, treating nonsense as the start', async () => {
    const { get, statements } = setup();
    await get('/desk?cursor=50');
    expect(named(statements, 'FROM tickets')[0]?.values).toContain(50);
    const again = setup();
    await again.get('/desk?cursor=-5');
    expect(named(again.statements, 'FROM tickets')[0]?.values).toContain(0);
  });
});

describe('the unread badge', () => {
  it('answers the count for this person', async () => {
    const response = await setup({ unread: 4 }).get('/desk/api/unread');
    expect(await response.json()).toEqual({ count: 4 });
  });

  it('loads its script without signing in', async () => {
    const { app, env } = setup();
    const response = await app.request('/desk.js', {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('/* desk */');
  });
});

describe('the ticket view', () => {
  it('shows the thread escaped, the fields, and a removed attachment', async () => {
    const page = await (await setup().get('/desk/tickets/t1')).text();
    expect(page).toContain('Help &lt;script&gt;');
    expect(page).toContain('ana@example.com');
    expect(page).toContain('Device');
    expect(page).toContain('Attachment removed');
    expect(page).toContain(REP);
  });

  it("is 404 for a ticket out of the rep's scope", async () => {
    const response = await setup({ tickets: [] }).get('/desk/tickets/t1');
    expect(response.status).toBe(404);
  });

  it("offers the product's canned replies for this type, filled in", async () => {
    const page = await (await setup().get('/desk/tickets/t1')).text();
    expect(page).toContain('Thanks');
    expect(page).toContain('Hello ana@example.com, about Cannot &lt;b&gt;sign&lt;/b&gt; in.');
    expect(page).not.toContain('Other type');
  });

  it('marks the ticket read for this person', async () => {
    const { get, statements } = setup();
    await get('/desk/tickets/t1');
    expect(named(statements, 'INTO reads')[0]?.values).toEqual(expect.arrayContaining([REP, 't1']));
  });

  it('says how the email went, after a reply', async () => {
    const { get } = setup();
    expect(await (await get('/desk/tickets/t1?mail=sent')).text()).toContain('The customer has been emailed.');
    expect(await (await get('/desk/tickets/t1?mail=failed')).text()).toContain('the email could not be sent');
    expect(await (await get('/desk/tickets/t1?mail=share-used-up')).text()).toContain('monthly email share');
    expect(await (await get('/desk/tickets/t1?mail=no-link')).text()).toContain('no private link');
    expect(await (await get('/desk/tickets/t1?mail=nonsense')).text()).not.toContain('emailed');
  });

  it('says when a reply was empty', async () => {
    expect(await (await setup().get('/desk/tickets/t1?error=empty')).text()).toContain('Enter a reply.');
  });
});

describe('the ticket view, attachments', () => {
  const stored = [
    { id: 'a1', message_id: 'm1', mime: 'image/jpeg', bytes: 2000, duration_ms: null, state: 'stored' },
    { id: 'a2', message_id: 'm1', mime: 'video/mp4', bytes: 9000, duration_ms: 65_000, state: 'stored' },
    { id: 'a3', message_id: 'm2', mime: 'image/png', bytes: 1000, duration_ms: null, state: 'deleted' },
  ];

  it('shows each stored attachment as a preview that opens the viewer, numbered across the ticket', async () => {
    const page = await (await setup({ attachments: stored }).get('/desk/tickets/t1')).text();
    expect(page).toContain('<button type="button" data-view data-id="a1" data-mime="image/jpeg" aria-label="Open photo 1">');
    expect(page).toContain('<img src="/desk/files/a1/thumb" alt="Photo 1 preview"');
    expect(page).toContain('<button type="button" data-view data-id="a2" data-mime="video/mp4" aria-label="Open video 2">');
    expect(page).toContain('<img src="/desk/files/a2/thumb" alt="Video 2 preview"');
  });

  it('gives a video its length as m:ss', async () => {
    const page = await (await setup({ attachments: stored }).get('/desk/tickets/t1')).text();
    expect(page).toContain('Video 2, 1:05, 9 KB');
    expect(page).toContain('Photo 1, 2 KB');
  });

  it('shows a removed attachment as a line, not a preview', async () => {
    const page = await (await setup({ attachments: stored }).get('/desk/tickets/t1')).text();
    expect(page).toContain('<li>Attachment removed</li>');
    expect(page).not.toContain('a3');
  });
});

describe('opening a file', () => {
  it('streams a stored attachment of a ticket in scope inline, with its type, private and never sniffed', async () => {
    const response = await setup().get('/desk/files/a2');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('video bytes');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Disposition')).toBe('inline');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    // Opened on its own, the file runs nothing and reaches nothing (defence in depth: uploads take JPEG, WebP and MP4 only).
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
  });

  it('never shows inline a type outside JPEG, WebP and MP4: it downloads as plain bytes', async () => {
    const w = setup({ files: [{ r2_key: 'key-a2', thumb_key: 'thumb-a2', mime: 'text/html' }] });
    const response = await w.get('/desk/files/a2');
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('never shows inline a preview stored as another type', async () => {
    const w = setup({ objects: { 'thumb-a2': { body: '<svg/>', type: 'image/svg+xml' } } });
    const response = await w.get('/desk/files/a2/thumb');
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('streams its preview with the type it was stored with, inline', async () => {
    const response = await setup().get('/desk/files/a2/thumb');
    expect(await response.text()).toBe('small');
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Content-Disposition')).toBe('inline');
  });

  it("asks for the file among the rep's own products only", async () => {
    const w = setup();
    await w.get('/desk/files/a2');
    const [lookup] = named(w.statements, 'FROM attachments a JOIN tickets');
    expect(lookup?.values).toEqual(['a2', 'shytalk']);
  });

  it.each(['/desk/files/a2', '/desk/files/a2/thumb'])('is 404 at %s for a file out of scope or not stored', async (path) => {
    expect((await setup({ files: [] }).get(path)).status).toBe(404);
  });

  it('is 404 when the stored bytes have gone', async () => {
    expect((await setup({ objects: {} }).get('/desk/files/a2')).status).toBe(404);
  });

  it('is 404 for the preview of an attachment that has none', async () => {
    const w = setup({ files: [{ r2_key: 'key-a2', thumb_key: null, mime: 'video/mp4' }] });
    expect((await w.get('/desk/files/a2/thumb')).status).toBe(404);
  });

  it('is 401 with no Access token', async () => {
    const w = setup();
    expect((await w.app.request('/desk/files/a2', {}, w.env)).status).toBe(401);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('has no %s route: nothing can change a file', async (method) => {
    const w = setup();
    for (const path of ['/desk/files/a2', '/desk/files/a2/thumb']) expect((await w.get(path, ADMIN, method)).status).toBe(404);
  });
});

describe('replying', () => {
  const sealed = async (token: string) => ticketRow({ token_sealed: await sealToken(KEY, token) });

  it('saves the reply under the rep, sets waiting, starts the 7-day timer and emails the unchanged link', async () => {
    const { post, statements, plans, mails } = setup({ tickets: [await sealed('the-token')] });
    const response = await post('/desk/tickets/t1/reply', { body: 'We fixed it' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?mail=sent');
    expect(named(statements, 'INSERT INTO messages')[0]?.values).toEqual([
      expect.any(String),
      't1',
      REP,
      'We fixed it',
      expect.any(Number),
    ]);
    expect(named(statements, 'UPDATE tickets')[0]?.values[0]).toBe('waiting');
    expect(plans[0]?.schedule.autoclose).toEqual(expect.any(Number));
    expect(plans[0]?.cancel).toEqual(['attachments', 'text']);
    expect(mails[0]?.to).toBe('ana@example.com');
    expect(mails[0]?.text).toContain('https://shytalk.example/ticket#t=the-token');
    expect(mails[0]?.text).not.toContain('We fixed it');
  });

  it('says the email failed if the ticket has lost its product, keeping the reply', async () => {
    const { post, statements } = setup({ tickets: [await sealed('the-token')], productGone: true });
    const response = await post('/desk/tickets/t1/reply', { body: 'x' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?mail=failed');
    expect(named(statements, 'INSERT INTO messages')).toHaveLength(1);
  });

  it('treats a reply sent as a file as empty', async () => {
    const { app, env, statements } = setup();
    const form = new FormData();
    form.append('body', new File(['x'], 'x.txt'));
    const response = await app.request(
      '/desk/tickets/t1/reply',
      { method: 'POST', body: form, headers: { 'Cf-Access-Jwt-Assertion': await sign(REP), Origin: ORIGIN } },
      env,
    );
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?error=empty');
    expect(named(statements, 'INSERT INTO messages')).toEqual([]);
  });

  it('keeps the reply when the monthly email share is used up, and says so', async () => {
    const { post, mails, statements } = setup({ tickets: [await sealed('the-token')], mailShareUsed: true });
    const response = await post('/desk/tickets/t1/reply', { body: 'x' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?mail=share-used-up');
    expect(mails).toEqual([]);
    expect(named(statements, 'INSERT INTO messages')).toHaveLength(1);
  });

  it('keeps the reply when the email fails, and says so', async () => {
    const { post, statements } = setup({ tickets: [await sealed('the-token')], mailFails: true });
    const response = await post('/desk/tickets/t1/reply', { body: 'x' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?mail=failed');
    expect(named(statements, 'INSERT INTO messages')).toHaveLength(1);
  });

  it('keeps the reply and says so for a ticket from before links were kept', async () => {
    const { post, mails, statements } = setup();
    const response = await post('/desk/tickets/t1/reply', { body: 'x' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?mail=no-link');
    expect(mails).toEqual([]);
    expect(named(statements, 'INSERT INTO messages')).toHaveLength(1);
  });

  it('says the email failed on a deploy with no token key, keeping the reply', async () => {
    const { post, statements } = setup({ tickets: [await sealed('the-token')], noTokenKey: true });
    const response = await post('/desk/tickets/t1/reply', { body: 'x' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?mail=failed');
    expect(named(statements, 'INSERT INTO messages')).toHaveLength(1);
  });

  it('says the email failed when the sealed token will not open, keeping the reply', async () => {
    const { post, statements } = setup({ tickets: [ticketRow({ token_sealed: 'not-a-sealed-token' })] });
    const response = await post('/desk/tickets/t1/reply', { body: 'x' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?mail=failed');
    expect(named(statements, 'INSERT INTO messages')).toHaveLength(1);
  });

  it.each([
    ['empty', '   '],
    ['over 10,000 characters', 'x'.repeat(10_001)],
  ])('sends back a reply that is %s, saving nothing', async (_name, body) => {
    const { post, statements } = setup();
    const response = await post('/desk/tickets/t1/reply', { body });
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1?error=empty');
    expect(named(statements, 'INSERT INTO messages')).toEqual([]);
  });

  it("is 404 for a ticket out of the rep's scope, saving nothing", async () => {
    const { post, statements } = setup({ tickets: [] });
    expect((await post('/desk/tickets/t1/reply', { body: 'x' })).status).toBe(404);
    expect(named(statements, 'INSERT INTO messages')).toEqual([]);
  });

  it('refuses a post from another origin', async () => {
    const { post, statements } = setup();
    expect((await post('/desk/tickets/t1/reply', { body: 'x' }, REP, 'https://evil.example')).status).toBe(403);
    expect(named(statements, 'INSERT INTO messages')).toEqual([]);
  });
});

describe('closing', () => {
  it('sets closed and starts the retention timers', async () => {
    const { post, statements, plans } = setup();
    const response = await post('/desk/tickets/t1/close');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/t1');
    expect(named(statements, 'UPDATE tickets')[0]?.values[0]).toBe('closed');
    expect(plans[0]?.schedule.attachments).toEqual(expect.any(Number));
    expect(plans[0]?.schedule.text).toEqual(expect.any(Number));
  });

  it("is 404 for a ticket out of the rep's scope", async () => {
    const { post, plans } = setup({ tickets: [] });
    expect((await post('/desk/tickets/t1/close')).status).toBe(404);
    expect(plans).toEqual([]);
  });

  it('refuses a post from another origin', async () => {
    expect((await setup().post('/desk/tickets/t1/close', {}, REP, 'https://evil.example')).status).toBe(403);
  });
});

describe('fillCanned', () => {
  const values = { customer_email: 'ana@example.com', ticket_subject: 'Sign in' };

  it('fills both placeholders, every time they appear', () => {
    expect(fillCanned('{{customer_email}} {{ticket_subject}} {{customer_email}}', values)).toBe('ana@example.com Sign in ana@example.com');
  });

  it('leaves an unknown placeholder as typed', () => {
    expect(fillCanned('Hi {{customer_name}}', values)).toBe('Hi {{customer_name}}');
  });

  it('does not treat a subject holding a placeholder as another placeholder', () => {
    expect(fillCanned('{{ticket_subject}}', { customer_email: 'a@b.c', ticket_subject: '{{customer_email}}' })).toBe('{{customer_email}}');
  });
});
