import { describe, expect, it } from 'vitest';
import { apiRoutes } from '../../src/api/routes.ts';
import { hashKey } from '../../src/products.ts';
import { standInDb, type Statement } from './d1-stand-in.ts';

// The in-product appeal (shyden-labs/shydesk#61; Release 2 plan Task 5): the
// product's server names the punishment it shows the user, with the same one-
// appeal rules as the ban notice link. Another product's key, or a punishment of
// another product, is not found.

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));
const SHYTALK_KEY = 'shytalk-key';
const YAWELO_KEY = 'yawelo-key';
const PATH = '/api/v1/products/shytalk/appeals';
const PRODUCT = {
  id: 'shytalk',
  name: 'ShyTalk',
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: '["https://shytalk.app"]',
  test_origins_json: '[]',
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
};

interface World {
  lifted?: boolean;
  appealed?: boolean;
  counted?: number;
  noTokenKey?: boolean;
}

async function setup(w: World = {}) {
  const keys = new Map([
    [await hashKey(SHYTALK_KEY), 'shytalk'],
    [await hashKey(YAWELO_KEY), 'yawelo-idle'],
  ]);
  let appealed = w.appealed === true;
  const { db, statements } = standInDb((sql, values) => {
    if (sql.includes('FROM api_keys')) {
      const product = keys.get(String(values[0]));
      return product ? [{ product_id: product, revoked_at: null }] : [];
    }
    if (sql.includes('RETURNING value') && String(values[0]).startsWith('appeals:')) return [{ value: w.counted ?? 1 }];
    if (sql.includes('FROM products WHERE id = ?')) return values[0] === 'shytalk' ? [PRODUCT] : [];
    if (sql.includes('FROM punishments p LEFT JOIN appeals')) {
      if (values[0] !== 'p1' || values[1] !== 'shytalk') return [];
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
  const app = apiRoutes();
  const env = { DB: db, ...(w.noTokenKey === true ? {} : { TICKET_TOKEN_KEY: KEY }) };
  const send = (
    body: unknown = { punishment_id: 'p1', email: 'a@example.com', message: 'Please look again.' },
    key = SHYTALK_KEY,
    path = PATH,
  ) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      env,
    );
  return { send, statements, db };
}

const appealInserts = (statements: Statement[]) => statements.filter((s) => /^INSERT INTO appeals/.test(s.sql));
const batches = (statements: Statement[]) => statements.filter((s) => s.method === 'batch');

describe('POST /api/v1/products/{product}/appeals', () => {
  it("makes one appeal and answers 201 with the appellant's private ticket link", async () => {
    const { send, statements } = await setup();
    const response = await send();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ticket_url: expect.stringMatching(/^https:\/\/shytalk\.app\/support\/ticket#t=[A-Za-z0-9_-]{43}$/) as unknown,
    });
    expect(appealInserts(statements)).toHaveLength(1);
  });

  it('answers a second appeal for the same punishment with 409 already_appealed, keeping one', async () => {
    const { send, statements } = await setup();
    expect((await send()).status).toBe(201);
    const second = await send();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_appealed' });
    expect(appealInserts(statements)).toHaveLength(1);
  });

  it('answers 409 already_appealed after a rejected appeal', async () => {
    const response = await (await setup({ appealed: true })).send();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'already_appealed' });
  });

  it('answers 409 lifted for a lifted punishment, writing nothing', async () => {
    const { send, statements } = await setup({ lifted: true });
    const response = await send();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'lifted' });
    expect(batches(statements)).toEqual([]);
  });

  it('is 404 for an unknown punishment', async () => {
    const { send, statements } = await setup();
    const response = await send({ punishment_id: 'nope', email: 'a@example.com', message: 'm' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(batches(statements)).toEqual([]);
  });

  it("is 404 for another product's key on this product's path, before anything is read", async () => {
    const { send, statements } = await setup();
    const response = await send(undefined, YAWELO_KEY);
    expect(response.status).toBe(404);
    expect(statements.some((s) => s.sql.includes('FROM punishments'))).toBe(false);
  });

  it("is 404 for this product's key asking about another product's punishment", async () => {
    const { send } = await setup();
    expect((await send(undefined, YAWELO_KEY, '/api/v1/products/yawelo-idle/appeals')).status).toBe(404);
  });

  it.each([
    ['no body', '{not json'],
    ['an array', '[1]'],
    ['no punishment id', { email: 'a@example.com', message: 'm' }],
    ['a punishment id that is not text', { punishment_id: 7, email: 'a@example.com', message: 'm' }],
    ['a bad email', { punishment_id: 'p1', email: 'nope', message: 'm' }],
    ['an empty message', { punishment_id: 'p1', email: 'a@example.com', message: ' ' }],
  ])('answers 400 bad_request for %s, writing nothing', async (_case, body) => {
    const { send, statements } = await setup();
    const response = await send(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request' });
    expect(batches(statements)).toEqual([]);
  });

  it('answers 429 rate_limited past 120 a minute for the product, before reading anything', async () => {
    const { send, statements } = await setup({ counted: 121 });
    const response = await send();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expect(statements.some((s) => s.sql.includes('FROM punishments'))).toBe(false);
  });

  it('takes the 120th of the minute', async () => {
    expect((await (await setup({ counted: 120 })).send()).status).toBe(201);
  });

  it('lets a database failure through as a 500, never as a refusal', async () => {
    const { send, db } = await setup();
    db.batch = () => Promise.reject(new Error('D1 is down'));
    expect((await send()).status).toBe(500);
  });

  it('answers 503 unavailable when the ticket-link key is not set, writing nothing', async () => {
    const { send, statements } = await setup({ noTokenKey: true });
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(batches(statements)).toEqual([]);
  });
});
