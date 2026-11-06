// The settings store on a real D1 database with the Release 1 schema
// (shyden-labs/shydesk#17): the SQL the unit tests read is accepted by D1,
// round-trips, and keeps its isolation rules. Each test uses its own product
// ids, so the tests share one database without touching each other's rows.
import { describe, expect, inject, it } from 'vitest';
import { loadStaff } from '../../src/auth/staff.ts';
import {
  createApiKey,
  getProduct,
  getTicketType,
  hashKey,
  listApiKeys,
  listCanned,
  productForOrigin,
  revokeApiKey,
  saveCanned,
  saveProduct,
  saveStaff,
  saveTicketType,
  supportTypeId,
  type ProductInput,
} from '../../src/products.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));

const product = (id: string): ProductInput => ({
  id,
  name: `Product ${id}`,
  senderAddress: `no-reply@${id}.example`,
  ticketPageUrl: `https://${id}.example/ticket`,
  allowedOrigins: [`https://${id}.example`],
  monthlyEmailShare: 100,
  attachmentsKeepDays: 30,
  textKeepDays: 365,
});

describe('products', () => {
  it('round-trips a product and keeps created_at on update', async () => {
    await saveProduct(db, product('it-round'), 1000);
    await saveProduct(db, { ...product('it-round'), name: 'Renamed', monthlyEmailShare: 0 }, 2000);
    await expect(getProduct(db, 'it-round')).resolves.toEqual({
      ...product('it-round'),
      name: 'Renamed',
      monthlyEmailShare: 0,
      createdAt: 1000,
    });
  });

  it('answers a product only for its own origin', async () => {
    await saveProduct(db, product('it-origin'), 1000);
    await expect(productForOrigin(db, 'it-origin', 'https://it-origin.example')).resolves.toMatchObject({ id: 'it-origin' });
    await expect(productForOrigin(db, 'it-origin', 'https://evil.example')).resolves.toBeNull();
  });
});

describe('staff', () => {
  it("replaces a rep's grants and loadStaff sees only them", async () => {
    await saveProduct(db, product('it-a'), 1000);
    await saveProduct(db, product('it-b'), 1000);
    await saveStaff(db, { email: 'it-rep@example.com', role: 'rep', products: ['it-a', 'it-b'] }, 1000);
    await saveStaff(db, { email: 'it-rep@example.com', role: 'rep', products: ['it-b'] }, 2000);
    await expect(loadStaff(db, 'it-rep@example.com', 'first-admin@example.com')).resolves.toEqual({
      email: 'it-rep@example.com',
      role: 'rep',
      products: ['it-b'],
    });
  });

  it('refuses a grant to a missing product and leaves the rep unsaved', async () => {
    await expect(saveStaff(db, { email: 'it-ghost@example.com', role: 'rep', products: ['it-ghost'] }, 1000)).rejects.toMatchObject({
      errors: ['No such product: it-ghost.'],
    });
    await expect(loadStaff(db, 'it-ghost@example.com', 'first-admin@example.com')).resolves.toBeNull();
  });
});

describe('support type and canned replies', () => {
  it('round-trips the support fields and a canned reply on that type', async () => {
    await saveProduct(db, product('it-type'), 1000);
    const fields = [{ label: 'Area', kind: 'select' as const, required: true, options: ['Chat'] }];
    await saveTicketType(db, { productId: 'it-type', name: 'Support', fields });
    await expect(getTicketType(db, 'it-type')).resolves.toEqual({ id: supportTypeId('it-type'), name: 'Support', fields });
    const id = await saveCanned(db, { productId: 'it-type', typeId: supportTypeId('it-type'), name: 'Hi', body: 'Hello.' });
    await expect(listCanned(db, 'it-type')).resolves.toEqual([{ id, typeId: supportTypeId('it-type'), name: 'Hi', body: 'Hello.' }]);
  });

  it("refuses a canned reply on another product's type", async () => {
    await saveProduct(db, product('it-c1'), 1000);
    await saveProduct(db, product('it-c2'), 1000);
    await saveTicketType(db, { productId: 'it-c2', name: 'Support', fields: [] });
    await expect(saveCanned(db, { productId: 'it-c1', typeId: supportTypeId('it-c2'), name: 'A', body: 'B' })).rejects.toMatchObject({
      errors: [`No such ticket type for this product: ${supportTypeId('it-c2')}.`],
    });
  });
});

describe('API keys', () => {
  it('stores only the hash and revokes only within the product', async () => {
    await saveProduct(db, product('it-k1'), 1000);
    await saveProduct(db, product('it-k2'), 1000);
    const key = await createApiKey(db, 'it-k1', 'Feed', 1000);
    const [stored] = await listApiKeys(db, 'it-k1');
    expect(stored).toEqual({ hash: await hashKey(key), label: 'Feed', createdAt: 1000, revokedAt: null });
    await revokeApiKey(db, 'it-k2', await hashKey(key), 2000);
    expect((await listApiKeys(db, 'it-k1'))[0]?.revokedAt).toBeNull();
    await revokeApiKey(db, 'it-k1', await hashKey(key), 3000);
    expect((await listApiKeys(db, 'it-k1'))[0]?.revokedAt).toBe(3000);
  });
});
