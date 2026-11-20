import { describe, it, expect } from 'vitest';
import { apiRoutes } from '../../src/api/routes.ts';
import { hashKey } from '../../src/products.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// GET /api/v1/products/{product}/feed (shyden-labs/shydesk#26): a product's
// new and changed tickets, oldest change first, paged by `seq`. Every change
// moves a ticket to a new seq, so `seq > since_cursor` returns each change once.
const KEY = 'feed-key';

const ticket = (seq: number) => ({
  id: `t${seq}`,
  status: 'open',
  subject: `Subject ${seq}`,
  category: 'bug',
  created_at: 1_000 + seq,
  updated_at: 2_000 + seq,
  closed_at: null,
  seq,
});

async function feedApp(tickets: ReturnType<typeof ticket>[]) {
  const hash = await hashKey(KEY);
  const answer: Answer = (sql, values) => {
    if (sql.includes('FROM api_keys')) return values[0] === hash ? [{ product_id: 'shytalk', revoked_at: null }] : [];
    if (sql.includes('FROM tickets')) return tickets;
    return [];
  };
  const { db, statements } = standInDb(answer);
  const app = apiRoutes();
  const get = (query: string, product = 'shytalk') =>
    app.request(`/api/v1/products/${product}/feed${query}`, { headers: { Authorization: `Bearer ${KEY}` } }, { DB: db });
  const feedReads = () => statements.filter((s) => s.sql.includes('FROM tickets'));
  return { get, feedReads };
}

describe('GET /api/v1/products/{product}/feed', () => {
  it('returns the tickets and the last seq as next_cursor', async () => {
    const { get } = await feedApp([ticket(4), ticket(7)]);
    const response = await get('?since_cursor=3&limit=2');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { id: 't4', status: 'open', subject: 'Subject 4', category: 'bug', created_at: 1004, updated_at: 2004, closed_at: null, seq: 4 },
        { id: 't7', status: 'open', subject: 'Subject 7', category: 'bug', created_at: 1007, updated_at: 2007, closed_at: null, seq: 7 },
      ],
      next_cursor: 7,
    });
  });

  it("reads only this product's tickets after the cursor, in seq order, up to the limit", async () => {
    const { get, feedReads } = await feedApp([]);
    await get('?since_cursor=3&limit=2');
    expect(feedReads()).toHaveLength(1);
    expect(feedReads()[0]?.sql).toMatch(/WHERE product_id = \? AND seq > \? ORDER BY seq LIMIT \?/);
    expect(feedReads()[0]?.values).toEqual(['shytalk', 3, 2]);
  });

  it('keeps the cursor where it was when nothing has changed', async () => {
    const { get } = await feedApp([]);
    expect(await (await get('?since_cursor=12')).json()).toEqual({ items: [], next_cursor: 12 });
  });

  it('starts from the beginning with 50 a page when no query is given', async () => {
    const { get, feedReads } = await feedApp([]);
    expect(await (await get('')).json()).toEqual({ items: [], next_cursor: 0 });
    expect(feedReads()[0]?.values).toEqual(['shytalk', 0, 50]);
  });

  it('accepts the smallest and largest limits, 1 and 100', async () => {
    const { get, feedReads } = await feedApp([]);
    expect((await get('?limit=1')).status).toBe(200);
    expect((await get('?limit=100')).status).toBe(200);
    expect(feedReads().map((s) => s.values[2])).toEqual([1, 100]);
  });

  it.each(['0', '101', '-1', '1.5', 'ten', ''])('refuses limit=%s with 400 and reads no tickets', async (limit) => {
    const { get, feedReads } = await feedApp([]);
    const response = await get(`?limit=${limit}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'limit must be a whole number from 1 to 100.' });
    expect(feedReads()).toHaveLength(0);
  });

  it.each(['-1', '1.5', 'x', '', '9007199254740992'])('refuses since_cursor=%s with 400', async (cursor) => {
    const { get, feedReads } = await feedApp([]);
    const response = await get(`?since_cursor=${cursor}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'since_cursor must be a whole number from 0.' });
    expect(feedReads()).toHaveLength(0);
  });

  it("refuses this product's key on another product's feed with 404", async () => {
    const { get, feedReads } = await feedApp([ticket(1)]);
    expect((await get('', 'yawelo-idle')).status).toBe(404);
    expect(feedReads()).toHaveLength(0);
  });
});
