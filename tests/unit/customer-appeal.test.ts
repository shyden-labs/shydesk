import { describe, expect, it } from 'vitest';
import { appealRoutes } from '../../src/customer/appeal.ts';
import type { SmtpMail } from '../../src/mail/smtp.ts';
import { hashKey } from '../../src/products.ts';
import { standInDb } from './d1-stand-in.ts';

// The appeal view's API (shyden-labs/shydesk#61; Release 2 plan Task 5). The
// token comes from the ban notice link's fragment and reaches ShyDesk only in
// the ShyDesk-Appeal header. One appeal per punishment: the same link used
// twice gives one appeal, then already_appealed; a lifted punishment, lifted.

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const ORIGIN = 'https://shytalk.app';
const TOKEN = 'appeal-token-of-p1';
const SHYTALK = {
  id: 'shytalk',
  name: 'ShyTalk',
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: JSON.stringify([ORIGIN]),
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
};

interface World {
  lifted?: boolean;
  appealed?: boolean;
  noTokenKey?: boolean;
  /** Sets BOUNCE_DOMAIN, so each notice is written down (shyden-labs/shydesk#232). */
  bounceDomain?: string;
  /** Hits already counted against the client IP this hour. */
  hits?: number;
}

async function setup(w: World = {}) {
  const tokenHash = await hashKey(TOKEN);
  let appealed = w.appealed === true;
  let hits = w.hits ?? 0;
  const { db, statements } = standInDb((sql, values) => {
    if (sql.includes('FROM products') && values[0] === 'shytalk') return [SHYTALK];
    if (/INSERT INTO counters \(key, value, window_start\)/.test(sql)) return [{ value: ++hits }];
    if (/INTO counters/.test(sql)) return [{ value: 1 }];
    if (/FROM punishments p LEFT JOIN appeals/.test(sql)) {
      const [key, product] = values;
      if (product !== 'shytalk' || (key !== tokenHash && key !== 'p1')) return [];
      return [
        {
          id: 'p1',
          product_id: 'shytalk',
          label: 'Ban 7 days',
          created_at: 500,
          lifted_at: w.lifted === true ? 900 : null,
          appealed: appealed ? 1 : 0,
        },
      ];
    }
    return [];
  });
  const realBatch = db.batch.bind(db);
  db.batch = (async (list: Parameters<typeof realBatch>[0]) => {
    const done = await realBatch(list);
    if (list.some((s) => /INSERT INTO appeals/.test((s as unknown as { sql: string }).sql))) appealed = true;
    return done;
  }) as typeof db.batch;
  const mails: SmtpMail[] = [];
  const app = appealRoutes({
    deliver: (_login, mail) => {
      mails.push(mail);
      return Promise.resolve();
    },
  });
  const env = {
    DB: db,
    SMTP_LOGINS: JSON.stringify({ 'no-reply@shytalk.app': { user: 'u', pass: 'p' } }),
    ...(w.noTokenKey === true ? {} : { TICKET_TOKEN_KEY: KEY }),
    ...(w.bounceDomain === undefined ? {} : { BOUNCE_DOMAIN: w.bounceDomain }),
  };
  const headers = (token: string | null, extra: Record<string, string> = {}, origin = ORIGIN) => ({
    Origin: origin,
    'CF-Connecting-IP': '203.0.113.7',
    ...(token === null ? {} : { 'ShyDesk-Appeal': token }),
    ...extra,
  });
  const get = (token: string | null, query = '', origin = ORIGIN) =>
    app.request(`/support-api/appeals?product=shytalk${query}`, { headers: headers(token, {}, origin) }, env);
  const post = (token: string | null, body: unknown = { email: 'A@Example.com', message: 'Please look again.' }) =>
    app.request(
      '/support-api/appeals?product=shytalk',
      {
        method: 'POST',
        headers: headers(token, { 'Content-Type': 'application/json' }),
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      env,
    );
  return { get, post, statements, mails, db };
}

const appealInserts = (statements: { sql: string }[]) => statements.filter((s) => /^INSERT INTO appeals/.test(s.sql));

describe('GET /support-api/appeals', () => {
  it('names the punishment and that it can be appealed', async () => {
    const response = await (await setup()).get(TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ label: 'Ban 7 days', created_at: 500, can_appeal: true });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('says already_appealed once appealed', async () => {
    expect(await (await (await setup({ appealed: true })).get(TOKEN)).json()).toMatchObject({
      can_appeal: false,
      reason: 'already_appealed',
    });
  });

  it('says lifted for a lifted punishment', async () => {
    expect(await (await (await setup({ lifted: true })).get(TOKEN)).json()).toMatchObject({ can_appeal: false, reason: 'lifted' });
  });

  it('is 404 for an unknown token, no token, or a token put in the URL instead of the header', async () => {
    const { get } = await setup();
    for (const response of [await get('nope'), await get(null), await get(null, `&token=${TOKEN}`)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found.' });
    }
  });

  it('is 404 with no CORS header from an origin the product does not allow', async () => {
    const response = await (await setup()).get(TOKEN, '', 'https://evil.example');
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('POST /support-api/appeals', () => {
  it('writes the appeal notice down against the new appeal ticket, with no message (shyden-labs/shydesk#232)', async () => {
    const { post, statements, mails } = await setup({ bounceDomain: 'bounce.example' });
    expect((await post(TOKEN)).status).toBe(201);
    const ticketId = statements.find((s) => s.sql.includes('INSERT INTO tickets'))?.values[0];
    const notice = statements.find((s) => s.sql.startsWith('INSERT INTO notices'));
    expect(ticketId).toEqual(expect.any(String));
    expect(notice?.values.slice(1, 4)).toEqual([ticketId, null, 'a@example.com']);
    expect(mails[0]?.envelopeFrom).toBe(`bounce-${String(notice?.values[0])}@bounce.example`);
  });

  it('makes one appeal, answering 201 with the private ticket link, and mails that link to the appellant', async () => {
    const { post, statements, mails } = await setup();
    const response = await post(TOKEN);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ticket_url: string; email_sent: boolean };
    expect(body.ticket_url).toMatch(/^https:\/\/shytalk\.app\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);
    expect(body.email_sent).toBe(true);
    expect(appealInserts(statements)).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe('a@example.com');
    expect(mails[0]?.text).toContain(body.ticket_url);
  });

  it('answers the same link used twice with 201, then 409 already_appealed, keeping one appeal', async () => {
    const { post, statements } = await setup();
    expect((await post(TOKEN)).status).toBe(201);
    const second = await post(TOKEN);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_appealed' });
    expect(appealInserts(statements)).toHaveLength(1);
  });

  it('answers 409 already_appealed after the appeal was rejected', async () => {
    const second = await (await setup({ appealed: true })).post(TOKEN);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_appealed' });
  });

  it('answers 409 lifted for a lifted punishment, writing nothing', async () => {
    const { post, statements } = await setup({ lifted: true });
    const response = await post(TOKEN);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'lifted' });
    expect(statements.some((s) => s.method === 'batch')).toBe(false);
  });

  it('is 404 for an unknown token or none', async () => {
    const { post, statements } = await setup();
    expect((await post('nope')).status).toBe(404);
    expect((await post(null)).status).toBe(404);
    expect(statements.some((s) => s.method === 'batch')).toBe(false);
  });

  it('names every field in error at once', async () => {
    const response = await (await setup()).post(TOKEN, { email: 'nope', message: '' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { email: 'Enter a valid email address.', message: 'Enter a message.' } });
  });

  it('answers 400 for a body that cannot be read', async () => {
    const { post } = await setup();
    for (const body of ['{not json', '[1]']) {
      const response = await post(TOKEN, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'The request could not be read. Reload the page and try again.' });
    }
  });

  it('answers 503 naming nothing secret when the ticket-link key is not set, writing nothing', async () => {
    const { post, statements } = await setup({ noTokenKey: true });
    const response = await post(TOKEN);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Support requests cannot be taken right now. Try again later.' });
    expect(statements.some((s) => s.method === 'batch')).toBe(false);
  });

  it('lets a database failure through as a 500, never as a refusal', async () => {
    const { post, db } = await setup();
    db.batch = () => Promise.reject(new Error('D1 is down'));
    expect((await post(TOKEN)).status).toBe(500);
  });

  it('takes 20 appeals per client IP per hour and answers the 21st with 429, before looking the token up', async () => {
    const at20 = await setup({ hits: 19 });
    expect((await at20.post(TOKEN)).status).toBe(201);
    const over = await setup({ hits: 20 });
    const response = await over.post(TOKEN);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Too many requests for now. Try again in an hour.' });
    expect(over.statements.some((s) => /FROM punishments/.test(s.sql))).toBe(false);
  });
});
