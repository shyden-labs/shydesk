// The product API feed on a real D1 database with the Release 1 schema
// (shyden-labs/shydesk#26): paging by cursor returns each ticket change once,
// only for the key's own product, and a revoked key stops working at once.
import { describe, expect, inject, it } from 'vitest';
import { apiRoutes } from '../../src/api/routes.ts';
import { createApiKey, revokeApiKey, hashKey, saveProduct, saveTicketType, supportTypeId } from '../../src/products.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));

async function product(id: string): Promise<string> {
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
  return createApiKey(db, id, 'feed test', 1000);
}

async function ticket(productId: string, id: string, seq: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq)
       VALUES (?, ?, ?, 'open', 'someone@example.com', ?, 'bug', '{}', ?, 1000, 1000, ?)`,
    )
    .bind(id, productId, supportTypeId(productId), `Subject ${id}`, `hash-${id}`, seq)
    .run();
}

const app = apiRoutes();
const feed = async (productId: string, key: string, query: string) => {
  const response = await app.request(
    `/api/v1/products/${productId}/feed${query}`,
    { headers: { Authorization: `Bearer ${key}` } },
    { DB: db },
  );
  return { status: response.status, body: (await response.json()) as { items: { id: string }[]; next_cursor: number } };
};

describe('GET /api/v1/products/{product}/feed on D1', () => {
  it('pages by cursor and returns each change once', async () => {
    const key = await product('it-feed');
    await product('it-feed-other');
    await ticket('it-feed', 'it-feed-1', 1);
    await ticket('it-feed', 'it-feed-2', 2);
    await ticket('it-feed-other', 'it-feed-x', 3);
    await ticket('it-feed', 'it-feed-3', 4);

    const first = await feed('it-feed', key, '?limit=2');
    expect(first.body.items.map((t) => t.id)).toEqual(['it-feed-1', 'it-feed-2']);
    const second = await feed('it-feed', key, `?since_cursor=${first.body.next_cursor}&limit=2`);
    expect(second.body).toMatchObject({ items: [{ id: 'it-feed-3' }], next_cursor: 4 });

    // A change gives the ticket the next seq: it comes back once, after the cursor.
    await db.prepare("UPDATE tickets SET status = 'waiting', seq = 5 WHERE id = ?").bind('it-feed-1').run();
    const third = await feed('it-feed', key, '?since_cursor=4');
    expect(third.body).toMatchObject({ items: [{ id: 'it-feed-1', status: 'waiting' }], next_cursor: 5 });
    expect(await feed('it-feed', key, '?since_cursor=5')).toEqual({ status: 200, body: { items: [], next_cursor: 5 } });
  });

  it("refuses another product's key with 404 and a revoked key with 401", async () => {
    const key = await product('it-feed-keys');
    const otherKey = await product('it-feed-keys-b');
    expect((await feed('it-feed-keys', otherKey, '')).status).toBe(404);
    expect((await feed('it-feed-keys', key, '')).status).toBe(200);
    await revokeApiKey(db, 'it-feed-keys', await hashKey(key), 2000);
    expect((await feed('it-feed-keys', key, '')).status).toBe(401);
  });
});
