import { describe, it, expect } from 'vitest';
import {
  SettingsError,
  createApiKey,
  getProduct,
  getTicketType,
  hashKey,
  listApiKeys,
  listCanned,
  listProducts,
  listStaff,
  productForOrigin,
  revokeApiKey,
  saveCanned,
  saveProduct,
  saveStaff,
  saveTicketType,
  type ProductInput,
} from '../../src/products.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

/**
 * The settings store (shyden-labs/shydesk#17 AC1, AC2): what each function
 * writes and reads, on a D1 stand-in. The SQL itself runs against a real D1 in
 * tests/integration/products.test.ts.
 */

const NOW = 1_700_000_000_000;

const PRODUCT: ProductInput = {
  id: 'shytalk',
  name: 'ShyTalk',
  senderAddress: 'no-reply@shytalk.app',
  ticketPageUrl: 'https://shytalk.app/support/ticket',
  allowedOrigins: ['https://shytalk.app'],
  monthlyEmailShare: 500,
  attachmentsKeepDays: 30,
  textKeepDays: 365,
  privacyPolicyUrlEn: 'https://example.com/privacy',
  privacyPolicyUrlId: 'https://example.com/id/privacy',
};

const PRODUCT_ROW = {
  id: 'shytalk',
  name: 'ShyTalk',
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: '["https://shytalk.app"]',
  monthly_email_share: 500,
  attachments_keep_days: 30,
  text_keep_days: 365,
  privacy_url_en: 'https://example.com/privacy',
  privacy_url_id: 'https://example.com/id/privacy',
  created_at: NOW,
};

/** Answers product lookups from `ids`, and nothing else. */
const productsExist =
  (...ids: string[]): Answer =>
  (sql, values) =>
    /FROM products/.test(sql) ? ids.filter((id) => values.includes(id)).map((id) => ({ ...PRODUCT_ROW, id })) : [];

describe('saveProduct', () => {
  it('writes a valid product with its origins as JSON', async () => {
    const { db, statements } = standInDb();
    await saveProduct(db, PRODUCT, NOW);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/INSERT INTO products .* ON CONFLICT \(id\) DO UPDATE/s);
    expect(statements[0]?.values).toEqual([
      'shytalk',
      'ShyTalk',
      'no-reply@shytalk.app',
      'https://shytalk.app/support/ticket',
      '["https://shytalk.app"]',
      500,
      30,
      365,
      'https://example.com/privacy',
      'https://example.com/id/privacy',
      NOW,
    ]);
  });

  it('keeps created_at on update', async () => {
    const { db, statements } = standInDb();
    await saveProduct(db, PRODUCT, NOW);
    const update = statements[0]?.sql.split('DO UPDATE')[1] ?? '';
    expect(update).not.toMatch(/created_at/);
  });

  it('trims the name before saving', async () => {
    const { db, statements } = standInDb();
    await saveProduct(db, { ...PRODUCT, name: '  ShyTalk  ' }, NOW);
    expect(statements[0]?.values[1]).toBe('ShyTalk');
  });

  it('refuses an invalid product with every error and writes nothing', async () => {
    const { db, statements } = standInDb();
    const saving = saveProduct(db, { ...PRODUCT, id: 'X', monthlyEmailShare: -1 }, NOW);
    await expect(saving).rejects.toBeInstanceOf(SettingsError);
    await expect(saving).rejects.toMatchObject({
      errors: [
        'Product id must be 2 to 40 lowercase letters, digits or hyphens.',
        'Monthly email share must be a whole number of 0 or more.',
      ],
    });
    expect(statements).toEqual([]);
  });
});

describe('getProduct and listProducts', () => {
  it('reads a product back with its origins parsed', async () => {
    const { db, statements } = standInDb(productsExist('shytalk'));
    await expect(getProduct(db, 'shytalk')).resolves.toEqual({ ...PRODUCT, createdAt: NOW });
    expect(statements[0]?.values).toEqual(['shytalk']);
  });

  it('answers null for a missing product', async () => {
    const { db } = standInDb();
    await expect(getProduct(db, 'nope')).resolves.toBeNull();
  });

  it('lists every product in id order', async () => {
    const { db, statements } = standInDb(() => [PRODUCT_ROW, { ...PRODUCT_ROW, id: 'yawelo-idle' }]);
    const list = await listProducts(db);
    expect(list.map((p) => p.id)).toEqual(['shytalk', 'yawelo-idle']);
    expect(statements[0]?.sql).toMatch(/ORDER BY id/);
  });
});

describe('productForOrigin', () => {
  it('answers the product when the origin is allowed', async () => {
    const { db } = standInDb(productsExist('shytalk'));
    await expect(productForOrigin(db, 'shytalk', 'https://shytalk.app')).resolves.toMatchObject({ id: 'shytalk' });
  });

  it('answers null for an origin not allowed', async () => {
    const { db } = standInDb(productsExist('shytalk'));
    await expect(productForOrigin(db, 'shytalk', 'https://evil.example')).resolves.toBeNull();
  });

  it('answers null for a missing product', async () => {
    const { db } = standInDb();
    await expect(productForOrigin(db, 'nope', 'https://shytalk.app')).resolves.toBeNull();
  });
});

describe('saveStaff', () => {
  it('saves a rep and replaces their grants in one batch', async () => {
    const { db, statements } = standInDb(productsExist('shytalk', 'yawelo-idle'));
    await saveStaff(db, { email: ' Rep@Example.com ', role: 'rep', products: ['shytalk', 'yawelo-idle'] }, NOW);
    const batch = statements.filter((s) => s.method === 'batch');
    expect(batch.map((s) => s.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO staff',
      'DELETE FROM staff_products',
      'INSERT INTO staff_products',
      'INSERT INTO staff_products',
    ]);
    expect(batch[0]?.values).toEqual(['rep@example.com', 'rep', NOW]);
    expect(batch[1]?.values).toEqual(['rep@example.com']);
    expect(batch.slice(2).map((s) => s.values)).toEqual([
      ['rep@example.com', 'shytalk'],
      ['rep@example.com', 'yawelo-idle'],
    ]);
  });

  it('refuses a grant to a product that does not exist and writes nothing', async () => {
    const { db, statements } = standInDb(productsExist('shytalk'));
    const saving = saveStaff(db, { email: 'rep@example.com', role: 'rep', products: ['shytalk', 'ghost'] }, NOW);
    await expect(saving).rejects.toMatchObject({ errors: ['No such product: ghost.'] });
    expect(statements.filter((s) => s.method === 'batch')).toEqual([]);
  });

  it('refuses an email address with no domain', async () => {
    const { db } = standInDb();
    await expect(saveStaff(db, { email: 'rep', role: 'rep', products: [] }, NOW)).rejects.toMatchObject({
      errors: ['Email must be an email address ending in a domain.'],
    });
  });

  it('refuses a role that is not admin or rep', async () => {
    const { db } = standInDb();
    const role = 'owner' as 'rep';
    await expect(saveStaff(db, { email: 'a@b.co', role, products: [] }, NOW)).rejects.toMatchObject({
      errors: ['Role must be admin or rep.'],
    });
  });

  it('stores no grants for an admin, who sees every product', async () => {
    const { db, statements } = standInDb(productsExist('shytalk'));
    await saveStaff(db, { email: 'a@b.co', role: 'admin', products: ['shytalk'] }, NOW);
    const batch = statements.filter((s) => s.method === 'batch');
    expect(batch.map((s) => s.sql.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO staff', 'DELETE FROM staff_products']);
  });

  it('lists staff with their grants', async () => {
    const { db } = standInDb((sql) =>
      /FROM staff_products/.test(sql)
        ? [
            { email: 'rep@example.com', product_id: 'shytalk' },
            { email: 'rep@example.com', product_id: 'yawelo-idle' },
          ]
        : [
            { email: 'a@b.co', role: 'admin' },
            { email: 'rep@example.com', role: 'rep' },
          ],
    );
    await expect(listStaff(db)).resolves.toEqual([
      { email: 'a@b.co', role: 'admin', products: [] },
      { email: 'rep@example.com', role: 'rep', products: ['shytalk', 'yawelo-idle'] },
    ]);
  });
});

describe('saveTicketType and getTicketType', () => {
  const FIELDS = [
    { label: 'Device', kind: 'text' as const, required: true },
    { label: 'Area', kind: 'select' as const, required: false, options: ['Chat', 'Profile'] },
  ];

  it("writes the product's support type with its fields", async () => {
    const { db, statements } = standInDb(productsExist('shytalk'));
    await saveTicketType(db, { productId: 'shytalk', name: 'Support', fields: FIELDS });
    const write = statements.find((s) => s.method === 'run');
    expect(write?.sql).toMatch(/INSERT INTO ticket_types .* ON CONFLICT \(id\) DO UPDATE/s);
    expect(write?.values).toEqual(['shytalk:support', 'shytalk', 'support', 'Support', JSON.stringify(FIELDS), '[]', 1]);
  });

  it('refuses a missing product', async () => {
    const { db } = standInDb();
    await expect(saveTicketType(db, { productId: 'ghost', name: 'Support', fields: [] })).rejects.toMatchObject({
      errors: ['No such product: ghost.'],
    });
  });

  it('refuses an empty name, a field with no label and a select with no options', async () => {
    const { db, statements } = standInDb(productsExist('shytalk'));
    const saving = saveTicketType(db, {
      productId: 'shytalk',
      name: ' ',
      fields: [
        { label: '', kind: 'text', required: false },
        { label: 'Area', kind: 'select', required: false, options: [] },
      ],
    });
    await expect(saving).rejects.toMatchObject({
      errors: ['Name is required.', 'Field 1 needs a label.', 'Field "Area" is a choice list and needs at least one option.'],
    });
    expect(statements.filter((s) => s.method === 'run')).toEqual([]);
  });

  it('refuses a field kind other than text or select', async () => {
    const { db } = standInDb(productsExist('shytalk'));
    const kind = 'file' as 'text';
    await expect(
      saveTicketType(db, { productId: 'shytalk', name: 'Support', fields: [{ label: 'X', kind, required: false }] }),
    ).rejects.toMatchObject({ errors: ['Field "X" must be text or a choice list.'] });
  });

  it('reads the support type back, or null', async () => {
    const row = { id: 'shytalk:support', name: 'Support', fields_json: JSON.stringify(FIELDS) };
    const { db, statements } = standInDb((_sql, values) => (values[0] === 'shytalk' ? [row] : []));
    await expect(getTicketType(db, 'shytalk')).resolves.toEqual({ id: 'shytalk:support', name: 'Support', fields: FIELDS });
    expect(statements[0]?.sql).toMatch(/kind = 'support'/);
    await expect(getTicketType(db, 'other')).resolves.toBeNull();
  });
});

describe('saveCanned and listCanned', () => {
  it('writes a canned reply under a new id', async () => {
    const { db, statements } = standInDb(productsExist('shytalk'));
    const id = await saveCanned(db, { productId: 'shytalk', typeId: null, name: 'Thanks', body: 'Thanks for writing.' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const write = statements.find((s) => s.method === 'run');
    expect(write?.values).toEqual([id, 'shytalk', null, 'Thanks', 'Thanks for writing.']);
  });

  it('refuses an empty name or body', async () => {
    const { db } = standInDb(productsExist('shytalk'));
    await expect(saveCanned(db, { productId: 'shytalk', typeId: null, name: '', body: ' ' })).rejects.toMatchObject({
      errors: ['Name is required.', 'Reply text is required.'],
    });
  });

  it('refuses a missing product', async () => {
    const { db } = standInDb();
    await expect(saveCanned(db, { productId: 'ghost', typeId: null, name: 'A', body: 'B' })).rejects.toMatchObject({
      errors: ['No such product: ghost.'],
    });
  });

  it("refuses a ticket type that is not the product's", async () => {
    const { db } = standInDb(productsExist('shytalk'));
    await expect(saveCanned(db, { productId: 'shytalk', typeId: 'yawelo-idle:support', name: 'A', body: 'B' })).rejects.toMatchObject({
      errors: ['No such ticket type for this product: yawelo-idle:support.'],
    });
  });

  it("accepts the product's own ticket type", async () => {
    const answer: Answer = (sql, values) =>
      /FROM ticket_types/.test(sql)
        ? values[0] === 'shytalk:support' && values[1] === 'shytalk'
          ? [{ id: 'shytalk:support' }]
          : []
        : productsExist('shytalk')(sql, values);
    const { db, statements } = standInDb(answer);
    await saveCanned(db, { productId: 'shytalk', typeId: 'shytalk:support', name: 'A', body: 'B' });
    expect(statements.find((s) => s.method === 'run')?.values[2]).toBe('shytalk:support');
  });

  it("lists a product's canned replies by name, only that product's", async () => {
    const { db, statements } = standInDb(() => [{ id: 'c1', type_id: null, name: 'A', body: 'B' }]);
    await expect(listCanned(db, 'shytalk')).resolves.toEqual([{ id: 'c1', typeId: null, name: 'A', body: 'B' }]);
    expect(statements[0]?.sql).toMatch(/WHERE product_id = \? ORDER BY name/);
    expect(statements[0]?.values).toEqual(['shytalk']);
  });
});

describe('API keys', () => {
  it('hashes a key as lowercase hex SHA-256', async () => {
    // SHA-256 of "abc", from FIPS 180-2.
    await expect(hashKey('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('returns a 32-byte base64url key once and stores only its hash', async () => {
    const { db, statements } = standInDb(productsExist('shytalk'));
    const key = await createApiKey(db, 'shytalk', 'Feed reader', NOW);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const write = statements.find((s) => s.method === 'run');
    expect(write?.sql).toMatch(/INSERT INTO api_keys/);
    expect(write?.values).toEqual([await hashKey(key), 'shytalk', 'Feed reader', NOW]);
    expect(JSON.stringify(statements)).not.toContain(key);
  });

  it('makes a different key each time', async () => {
    const { db } = standInDb(productsExist('shytalk'));
    const a = await createApiKey(db, 'shytalk', 'A', NOW);
    const b = await createApiKey(db, 'shytalk', 'B', NOW);
    expect(a).not.toBe(b);
  });

  it('refuses a missing product or an empty label', async () => {
    const { db } = standInDb(productsExist('shytalk'));
    await expect(createApiKey(db, 'ghost', 'A', NOW)).rejects.toMatchObject({ errors: ['No such product: ghost.'] });
    await expect(createApiKey(db, 'shytalk', ' ', NOW)).rejects.toMatchObject({ errors: ['Label is required.'] });
  });

  it("lists a product's keys by hash, never a key", async () => {
    const { db, statements } = standInDb(() => [{ hash: 'h1', label: 'A', created_at: NOW, revoked_at: null }]);
    await expect(listApiKeys(db, 'shytalk')).resolves.toEqual([{ hash: 'h1', label: 'A', createdAt: NOW, revokedAt: null }]);
    expect(statements[0]?.values).toEqual(['shytalk']);
  });

  it('revokes a key only within its own product', async () => {
    const { db, statements } = standInDb();
    await revokeApiKey(db, 'shytalk', 'h1', NOW);
    expect(statements[0]?.sql).toMatch(/UPDATE api_keys SET revoked_at = \? WHERE hash = \? AND product_id = \? AND revoked_at IS NULL/);
    expect(statements[0]?.values).toEqual([NOW, 'h1', 'shytalk']);
  });
});
