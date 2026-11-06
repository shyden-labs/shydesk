import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { adminRoutes } from '../../src/admin/routes.ts';
import type { StaffEnv } from '../../src/auth/staff.ts';
import { hashKey } from '../../src/products.ts';
import { standInDb, type Answer, type Statement } from './d1-stand-in.ts';

/**
 * The admin settings screen (shyden-labs/shydesk#17 AC2, AC3): admin-only
 * routes under /admin, on a D1 stand-in. A rep gets 404 on every route, so a
 * rep cannot even learn the screen exists.
 */

const TEAM = 'shydesk-test.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-desk';
const ADMIN = 'admin@example.com';
const REP = 'rep@example.com';
const ORIGIN = 'http://localhost';

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

const productRow = (id: string, name = `Product ${id}`) => ({
  id,
  name,
  sender_address: `no-reply@${id}.example`,
  ticket_page_url: `https://${id}.example/ticket`,
  allowed_origins_json: JSON.stringify([`https://${id}.example`]),
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
});

interface World {
  products: ReturnType<typeof productRow>[];
  staff: { email: string; role: string }[];
  grants: { email: string; product_id: string }[];
  keys: { hash: string; label: string; created_at: number; revoked_at: number | null; product_id: string }[];
  /** The stored_bytes counter, and the rows the overdue query returns. */
  stored?: number;
  overdue?: { kind: string; id: string; product_id: string; due_at: number }[];
}

const world = (): World => ({
  products: [productRow('shytalk'), productRow('yawelo-idle')],
  staff: [{ email: REP, role: 'rep' }],
  grants: [{ email: REP, product_id: 'shytalk' }],
  keys: [],
});

const answerFrom =
  (w: World): Answer =>
  (sql, values) => {
    if (/UNION ALL/.test(sql)) return w.overdue ?? [];
    if (/FROM counters/.test(sql)) return w.stored === undefined ? [] : [{ value: w.stored }];
    if (/FROM products WHERE id = \?/.test(sql)) return w.products.filter((p) => p.id === values[0]);
    if (/FROM products WHERE id IN/.test(sql)) return w.products.filter((p) => values.includes(p.id));
    if (/FROM products/.test(sql)) return w.products;
    if (/FROM staff_products WHERE lower/.test(sql)) return w.grants.filter((g) => g.email === values[0]);
    if (/FROM staff_products/.test(sql)) return w.grants;
    if (/FROM staff WHERE lower/.test(sql)) return w.staff.filter((s) => s.email === values[0]);
    if (/FROM staff/.test(sql)) return w.staff;
    if (/FROM api_keys/.test(sql)) return w.keys.filter((k) => k.product_id === values[0]);
    return [];
  };

function setup(w: World = world()): { env: StaffEnv; statements: Statement[] } {
  const { db, statements } = standInDb(answerFrom(w));
  return { env: { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FIRST_ADMIN_EMAIL: ADMIN }, statements };
}

const app = () => adminRoutes(jwks);

async function get(path: string, who: string, env: StaffEnv): Promise<Response> {
  return app().request(path, { headers: { 'Cf-Access-Jwt-Assertion': await sign(who) } }, env);
}

async function post(path: string, who: string, env: StaffEnv, form: Record<string, string | string[]>, origin = ORIGIN): Promise<Response> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) body.append(k, one);
  return app().request(
    path,
    {
      method: 'POST',
      body,
      headers: { 'Cf-Access-Jwt-Assertion': await sign(who), 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    },
    env,
  );
}

const writes = (statements: Statement[]) => statements.filter((s) => s.method === 'run' || s.method === 'batch');

const PRODUCT_FORM = {
  id: 'new-app',
  name: 'New App',
  senderAddress: 'no-reply@new.example',
  ticketPageUrl: 'https://new.example/ticket',
  allowedOrigins: 'https://new.example\nhttps://dev.new.example',
  monthlyEmailShare: '50',
  attachmentsKeepDays: '30',
  textKeepDays: '365',
};

describe('who may use /admin', () => {
  it.each([
    ['GET', '/admin'],
    ['GET', '/admin/products/shytalk'],
    ['GET', '/admin/products/yawelo-idle'],
    ['GET', '/admin/staff'],
    ['GET', '/admin/no-such-page'],
    ['POST', '/admin/products'],
    ['POST', '/admin/products/shytalk/support'],
    ['POST', '/admin/products/shytalk/canned'],
    ['POST', '/admin/products/shytalk/api-keys'],
    ['POST', '/admin/products/shytalk/api-keys/abc/revoke'],
    ['POST', '/admin/staff'],
  ])('a rep gets 404 on %s %s and nothing is written', async (method, path) => {
    const { env, statements } = setup();
    const response = method === 'GET' ? await get(path, REP, env) : await post(path, REP, env, PRODUCT_FORM);
    expect(response.status).toBe(404);
    expect(writes(statements)).toEqual([]);
  });

  it('refuses a request with no Access token with 401', async () => {
    const { env } = setup();
    expect((await app().request('/admin', {}, env)).status).toBe(401);
  });

  it('refuses someone Access let in who is not staff with 403', async () => {
    const { env } = setup();
    expect((await get('/admin', 'stranger@example.com', env)).status).toBe(403);
  });

  it("refuses an admin's form post from another origin and writes nothing", async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products', ADMIN, env, PRODUCT_FORM, 'https://evil.example');
    expect(response.status).toBe(403);
    expect(writes(statements)).toEqual([]);
  });

  it('answers 404 for a page that does not exist', async () => {
    const { env } = setup();
    expect((await get('/admin/no-such-page', ADMIN, env)).status).toBe(404);
  });
});

describe('products', () => {
  it('lists every product with links to each', async () => {
    const { env } = setup();
    const page = await (await get('/admin', ADMIN, env)).text();
    expect(page).toContain('href="/admin/products/shytalk"');
    expect(page).toContain('href="/admin/products/yawelo-idle"');
  });

  it('escapes what admins typed', async () => {
    const w = world();
    w.products = [productRow('shytalk', '<script>alert(1)</script>')];
    const page = await (await get('/admin', ADMIN, setup(w).env)).text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('adds a product from the form and goes to its page', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products', ADMIN, env, PRODUCT_FORM);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin/products/new-app');
    const write = writes(statements)[0];
    expect(write?.sql).toMatch(/INSERT INTO products/);
    expect(write?.values.slice(0, 8)).toEqual([
      'new-app',
      'New App',
      'no-reply@new.example',
      'https://new.example/ticket',
      '["https://new.example","https://dev.new.example"]',
      50,
      30,
      365,
    ]);
  });

  it('shows every error and keeps what was typed when the form is invalid', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products', ADMIN, env, { ...PRODUCT_FORM, id: 'Bad Id', monthlyEmailShare: '' });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain('Product id must be 2 to 40 lowercase letters, digits or hyphens.');
    expect(page).toContain('Monthly email share must be a whole number of 0 or more.');
    expect(page).toContain('value="Bad Id"');
    expect(page).toContain('role="alert"');
    expect(writes(statements)).toEqual([]);
  });

  it("shows a product's settings page", async () => {
    const { env } = setup();
    const response = await get('/admin/products/shytalk', ADMIN, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('value="no-reply@shytalk.example"');
  });

  it('answers 404 for a product that does not exist', async () => {
    const { env } = setup();
    expect((await get('/admin/products/ghost', ADMIN, env)).status).toBe(404);
  });

  it('saves a product from its own page under its own id', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products/shytalk', ADMIN, env, { ...PRODUCT_FORM, id: 'something-else' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin/products/shytalk');
    expect(writes(statements)[0]?.values[0]).toBe('shytalk');
  });
});

describe('support fields', () => {
  it('saves the support type with one field per line', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products/shytalk/support', ADMIN, env, {
      name: 'Support',
      fields: 'Device; text; required\nArea; select; optional; Chat, Profile\n\n',
    });
    expect(response.status).toBe(303);
    expect(writes(statements)[0]?.values[4]).toBe(
      JSON.stringify([
        { label: 'Device', kind: 'text', required: true },
        { label: 'Area', kind: 'select', required: false, options: ['Chat', 'Profile'] },
      ]),
    );
  });

  it('refuses a field line it cannot read, naming the line', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products/shytalk/support', ADMIN, env, { name: 'Support', fields: 'Device; text; maybe' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Line 1: write label; text or select; required or optional; then options for a choice list.');
    expect(writes(statements)).toEqual([]);
  });

  it('refuses a choice list with no options', async () => {
    const { env } = setup();
    const response = await post('/admin/products/shytalk/support', ADMIN, env, { name: 'Support', fields: 'Area; select; required' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Field &quot;Area&quot; is a choice list and needs at least one option.');
  });
});

describe('canned replies', () => {
  it('adds a canned reply for every type of the product', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products/shytalk/canned', ADMIN, env, { name: 'Thanks', body: 'Thanks for writing.', typeId: '' });
    expect(response.status).toBe(303);
    expect(writes(statements)[0]?.values.slice(1)).toEqual(['shytalk', null, 'Thanks', 'Thanks for writing.']);
  });

  it('refuses an empty reply with the reason on the page', async () => {
    const { env } = setup();
    const response = await post('/admin/products/shytalk/canned', ADMIN, env, { name: 'Thanks', body: '', typeId: '' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Reply text is required.');
  });
});

describe('API keys', () => {
  it('shows a new key once and stores only its hash', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products/shytalk/api-keys', ADMIN, env, { label: 'Feed reader' });
    expect(response.status).toBe(200);
    const page = await response.text();
    const key = /<output[^>]*>([A-Za-z0-9_-]{43})<\/output>/.exec(page)?.[1] ?? '';
    expect(key).toHaveLength(43);
    expect(page).toContain('shown once');
    expect(writes(statements)[0]?.values[0]).toBe(await hashKey(key));
    expect(JSON.stringify(statements)).not.toContain(key);
  });

  it('never shows a stored key again, only the start of its hash', async () => {
    const w = world();
    const hash = await hashKey('the-key');
    w.keys = [{ hash, label: 'Feed reader', created_at: 1, revoked_at: null, product_id: 'shytalk' }];
    const page = await (await get('/admin/products/shytalk', ADMIN, setup(w).env)).text();
    expect(page).toContain('Feed reader');
    expect(page).toContain(hash.slice(0, 12));
    expect(page).not.toContain('the-key');
  });

  it('refuses an empty label', async () => {
    const { env } = setup();
    const response = await post('/admin/products/shytalk/api-keys', ADMIN, env, { label: ' ' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Label is required.');
  });

  it("revokes a key within the product's page", async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products/shytalk/api-keys/abc123/revoke', ADMIN, env, {});
    expect(response.status).toBe(303);
    expect(writes(statements)[0]?.values.slice(1)).toEqual(['abc123', 'shytalk']);
  });
});

describe('staff', () => {
  it('lists staff with their products', async () => {
    const { env } = setup();
    const page = await (await get('/admin/staff', ADMIN, env)).text();
    expect(page).toContain(REP);
    expect(page).toContain('shytalk');
  });

  it('grants a rep products from ticked boxes', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/staff', ADMIN, env, {
      email: 'new@example.com',
      role: 'rep',
      products: ['shytalk', 'yawelo-idle'],
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin/staff');
    expect(writes(statements).map((s) => s.values)).toEqual([
      ['new@example.com', 'rep', expect.any(Number)],
      ['new@example.com'],
      ['new@example.com', 'shytalk'],
      ['new@example.com', 'yawelo-idle'],
    ]);
  });

  it('refuses a grant to a product that does not exist', async () => {
    const { env, statements } = setup();
    const response = await post('/admin/staff', ADMIN, env, { email: 'new@example.com', role: 'rep', products: 'ghost' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('No such product: ghost.');
    expect(writes(statements)).toEqual([]);
  });
});

describe('product routes for a product that does not exist', () => {
  it.each([
    '/admin/products/ghost',
    '/admin/products/ghost/support',
    '/admin/products/ghost/canned',
    '/admin/products/ghost/api-keys',
    '/admin/products/ghost/api-keys/abc/revoke',
  ])('an admin gets 404 on POST %s and nothing is written', async (path) => {
    const { env, statements } = setup();
    expect((await post(path, ADMIN, env, { ...PRODUCT_FORM, label: 'A', body: 'B', fields: '' })).status).toBe(404);
    expect(writes(statements)).toEqual([]);
  });
});

describe('refusals and failures', () => {
  it("shows the errors on the product's own page when its settings are invalid", async () => {
    const { env, statements } = setup();
    const response = await post('/admin/products/shytalk', ADMIN, env, { ...PRODUCT_FORM, name: ' ' });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain('Name is required.');
    expect(page).toContain('value="shytalk"');
    expect(writes(statements)).toEqual([]);
  });

  it('treats a file sent in a text field as empty', async () => {
    const { env } = setup();
    const body = new FormData();
    for (const [k, v] of Object.entries(PRODUCT_FORM)) body.append(k, v);
    body.set('name', new File(['x'], 'name.txt'));
    const response = await app().request(
      '/admin/products',
      { method: 'POST', body, headers: { 'Cf-Access-Jwt-Assertion': await sign(ADMIN), Origin: ORIGIN } },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Name is required.');
  });

  it('answers 500 when the database fails, rather than saying it saved', async () => {
    const w = world();
    const { db } = standInDb((sql, values) => {
      if (/INSERT INTO products/.test(sql)) throw new Error('D1 is down');
      return answerFrom(w)(sql, values);
    });
    const env: StaffEnv = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FIRST_ADMIN_EMAIL: ADMIN };
    expect((await post('/admin/products', ADMIN, env, PRODUCT_FORM)).status).toBe(500);
  });
});

describe('pages with saved settings', () => {
  const FIELDS = [
    { label: 'Device', kind: 'text', required: true },
    { label: 'Area', kind: 'select', required: false, options: ['Chat', 'Profile'] },
  ];

  function filled(): StaffEnv {
    const w = world();
    const base = answerFrom(w);
    const { db } = standInDb((sql, values) => {
      if (/FROM ticket_types/.test(sql)) return [{ id: 'shytalk:support', name: 'Help', fields_json: JSON.stringify(FIELDS) }];
      if (/FROM canned_replies/.test(sql)) return [{ id: 'c1', type_id: null, name: 'Thanks', body: 'Thanks for writing.' }];
      if (/FROM api_keys/.test(sql)) return [{ hash: 'f'.repeat(64), label: 'Old feed', created_at: 1, revoked_at: 2 }];
      return base(sql, values);
    });
    return { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FIRST_ADMIN_EMAIL: ADMIN };
  }

  it('shows the support fields one per line', async () => {
    const page = await (await get('/admin/products/shytalk', ADMIN, filled())).text();
    expect(page).toContain('Device; text; required\nArea; select; optional; Chat, Profile');
  });

  it('offers canned replies on the support type', async () => {
    const page = await (await get('/admin/products/shytalk', ADMIN, filled())).text();
    expect(page).toContain('<option value="shytalk:support">Help</option>');
  });

  it('lists the canned replies', async () => {
    const page = await (await get('/admin/products/shytalk', ADMIN, filled())).text();
    expect(page).toContain('<strong>Thanks</strong>: Thanks for writing.');
  });

  it('marks a revoked key and offers no revoke button for it', async () => {
    const page = await (await get('/admin/products/shytalk', ADMIN, filled())).text();
    expect(page).toMatch(/Old feed\s+\(ffffffffffff…\) revoked/);
    expect(page).not.toContain('Revoke Old feed');
  });

  it('adds a canned reply on the support type', async () => {
    const answer = answerFrom(world());
    const { db, statements } = standInDb((sql, values) =>
      /FROM ticket_types/.test(sql) ? [{ id: 'shytalk:support' }] : answer(sql, values),
    );
    const env: StaffEnv = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FIRST_ADMIN_EMAIL: ADMIN };
    const response = await post('/admin/products/shytalk/canned', ADMIN, env, { name: 'A', body: 'B', typeId: 'shytalk:support' });
    expect(response.status).toBe(303);
    expect(writes(statements)[0]?.values.slice(1)).toEqual(['shytalk', 'shytalk:support', 'A', 'B']);
  });

  it('shows an admin with no product list and a rep with none granted', async () => {
    const w = world();
    w.staff = [
      { email: 'boss@example.com', role: 'admin' },
      { email: 'new@example.com', role: 'rep' },
    ];
    w.grants = [];
    const page = await (await get('/admin/staff', ADMIN, setup(w).env)).text();
    expect(page).toContain('<li>boss@example.com: admin</li>');
    expect(page).toContain('<li>new@example.com: rep, no products</li>');
  });
});

describe('storage and missed timers on /admin (shyden-labs/shydesk#22 AC3)', () => {
  it('lists each item still stored past its due date', async () => {
    const w = { ...world(), overdue: [{ kind: 'attachment', id: 'a1', product_id: 'shytalk', due_at: Date.UTC(2026, 9, 1, 8, 5) }] };
    const page = await (await get('/admin', ADMIN, setup(w).env)).text();
    expect(page).toContain('<h2>Storage and timers</h2>');
    expect(page).toContain('<li>Attachment a1 (shytalk) was due for deletion at 2026-10-01 08:05 UTC and is still stored.</li>');
  });

  it('says so when nothing is past its due date', async () => {
    const page = await (await get('/admin', ADMIN, setup().env)).text();
    expect(page).toContain('<p>Nothing is past its due date.</p>');
  });

  it('shows the storage warning at 80 %', async () => {
    const page = await (await get('/admin', ADMIN, setup({ ...world(), stored: 8_000_000_000 }).env)).text();
    expect(page).toContain('<p role="alert">Attachment storage at 80 % of the free 10 GB.</p>');
  });

  it('hides the storage warning at 79.9 %', async () => {
    const page = await (await get('/admin', ADMIN, setup({ ...world(), stored: 7_990_000_000 }).env)).text();
    expect(page).not.toContain('Attachment storage at');
  });

  it('shows the same panel when an added product is refused', async () => {
    const w = { ...world(), stored: 9_000_000_000 };
    const response = await post('/admin/products', ADMIN, setup(w).env, { ...PRODUCT_FORM, name: '' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Attachment storage at 90 % of the free 10 GB.');
  });
});
