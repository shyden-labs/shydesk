import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireProductKey, type ApiEnv } from '../../src/api/auth.ts';
import { hashKey } from '../../src/products.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// Product servers call /api/v1 with `Authorization: Bearer <key>`
// (shyden-labs/shydesk#26). Only the key's hash is looked up; a key that is
// unknown or revoked gets 401, and a good key used for another product gets
// 404, so a key never learns which other products exist.
const KEY = 'k'.repeat(43);

async function keysAnswer(rows: { product_id: string; revoked_at: number | null }[]): Promise<Answer> {
  const hash = await hashKey(KEY);
  return (sql, values) => (sql.includes('FROM api_keys') && values[0] === hash ? rows : []);
}

function appWith(answer: Answer) {
  const { db, statements } = standInDb(answer);
  const app = new Hono<ApiEnv>();
  app.get('/api/v1/products/:product/ping', requireProductKey(), (c) => c.json({ product: c.var.productId }));
  const call = (product: string, headers: Record<string, string> = {}) =>
    app.request(`/api/v1/products/${product}/ping`, { headers }, { DB: db });
  return { call, statements };
}

describe('requireProductKey', () => {
  it('lets a live key of this product through and names the product', async () => {
    const { call } = appWith(await keysAnswer([{ product_id: 'shytalk', revoked_at: null }]));
    const response = await call('shytalk', { Authorization: `Bearer ${KEY}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: 'shytalk' });
  });

  it('looks the key up by its hash, never by the key itself', async () => {
    const { call, statements } = appWith(await keysAnswer([{ product_id: 'shytalk', revoked_at: null }]));
    await call('shytalk', { Authorization: `Bearer ${KEY}` });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toEqual([await hashKey(KEY)]);
    expect(JSON.stringify(statements)).not.toContain(KEY);
  });

  it('refuses a request with no Authorization header with 401 and reads nothing', async () => {
    const { call, statements } = appWith(await keysAnswer([{ product_id: 'shytalk', revoked_at: null }]));
    const response = await call('shytalk');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(statements).toHaveLength(0);
  });

  it('refuses a header that is not a Bearer key with 401', async () => {
    const { call } = appWith(await keysAnswer([{ product_id: 'shytalk', revoked_at: null }]));
    expect((await call('shytalk', { Authorization: `Basic ${KEY}` })).status).toBe(401);
  });

  it('refuses an empty Bearer key with 401', async () => {
    const { call } = appWith(await keysAnswer([{ product_id: 'shytalk', revoked_at: null }]));
    expect((await call('shytalk', { Authorization: 'Bearer ' })).status).toBe(401);
  });

  it('refuses an unknown key with 401', async () => {
    const { call } = appWith(await keysAnswer([]));
    expect((await call('shytalk', { Authorization: `Bearer ${KEY}` })).status).toBe(401);
  });

  it('refuses a revoked key with 401', async () => {
    const { call } = appWith(await keysAnswer([{ product_id: 'shytalk', revoked_at: 1 }]));
    expect((await call('shytalk', { Authorization: `Bearer ${KEY}` })).status).toBe(401);
  });

  it("refuses another product's key with 404", async () => {
    const { call } = appWith(await keysAnswer([{ product_id: 'yawelo-idle', revoked_at: null }]));
    const response = await call('shytalk', { Authorization: `Bearer ${KEY}` });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.' });
  });

  it('answers each refusal as JSON naming no key or product', async () => {
    const { call } = appWith(await keysAnswer([{ product_id: 'shytalk', revoked_at: 1 }]));
    const response = await call('shytalk', { Authorization: `Bearer ${KEY}` });
    expect(await response.json()).toEqual({ error: 'A valid API key is required.' });
  });
});
