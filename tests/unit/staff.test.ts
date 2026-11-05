import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import type { D1Database } from '@cloudflare/workers-types';
import { loadStaff, requireStaff, scope, type Staff, type StaffEnv } from '../../src/auth/staff.ts';

/**
 * Roles and product scope (shyden-labs/shydesk#16). The database is a
 * stand-in that answers each query from in-memory rows and records the SQL
 * and bound values, so the isolation rules are checked without a real D1.
 */

interface Rows {
  staff: { email: string; role: string }[];
  grants: { email: string; product_id: string }[];
  products: string[];
}

interface Query {
  sql: string;
  values: unknown[];
}

function standInDb(rows: Rows): { db: D1Database; queries: Query[] } {
  const queries: Query[] = [];
  const answer = (sql: string, values: unknown[]): unknown[] => {
    queries.push({ sql, values });
    const email = values[0];
    if (/FROM staff_products/.test(sql)) {
      return rows.grants
        .filter((g) => g.email.toLowerCase() === email)
        .map((g) => ({ product_id: g.product_id }))
        .sort((a, b) => a.product_id.localeCompare(b.product_id));
    }
    if (/FROM staff\b/.test(sql)) return rows.staff.filter((s) => s.email.toLowerCase() === email);
    if (/FROM products/.test(sql)) return [...rows.products].sort().map((id) => ({ id }));
    throw new Error(`unexpected query: ${sql}`);
  };
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    first: () => Promise.resolve(answer(sql, values)[0] ?? null),
    all: () => Promise.resolve({ results: answer(sql, values), success: true, meta: {} }),
  });
  return { db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database, queries };
}

const ROWS: Rows = {
  staff: [
    { email: 'rep@example.com', role: 'rep' },
    { email: 'Mixed@Example.com', role: 'rep' },
    { email: 'admin2@example.com', role: 'admin' },
    { email: 'odd@example.com', role: 'owner' },
  ],
  grants: [
    { email: 'rep@example.com', product_id: 'shytalk' },
    { email: 'Mixed@Example.com', product_id: 'yawelo-idle' },
    { email: 'admin2@example.com', product_id: 'shytalk' },
  ],
  products: ['yawelo-idle', 'shyden-co-uk', 'shytalk'],
};
const ALL = ['shyden-co-uk', 'shytalk', 'yawelo-idle'];
const FIRST_ADMIN = 'Shyden@Example.com';

describe('loadStaff', () => {
  it('makes FIRST_ADMIN_EMAIL an admin of every product with no staff row', async () => {
    const { db } = standInDb({ staff: [], grants: [], products: ROWS.products });
    await expect(loadStaff(db, 'shyden@example.com', FIRST_ADMIN)).resolves.toEqual<Staff>({
      email: 'shyden@example.com',
      role: 'admin',
      products: ALL,
    });
  });

  it('keeps FIRST_ADMIN_EMAIL an admin even when a staff row says rep', async () => {
    const { db } = standInDb({ ...ROWS, staff: [{ email: 'shyden@example.com', role: 'rep' }] });
    const staff = await loadStaff(db, 'shyden@example.com', FIRST_ADMIN);
    expect(staff?.role).toBe('admin');
    expect(staff?.products).toEqual(ALL);
  });

  it('gives an admin from the staff table every product, whatever their grants', async () => {
    const { db } = standInDb(ROWS);
    await expect(loadStaff(db, 'admin2@example.com', FIRST_ADMIN)).resolves.toEqual<Staff>({
      email: 'admin2@example.com',
      role: 'admin',
      products: ALL,
    });
  });

  it('gives a rep only their granted products', async () => {
    const { db } = standInDb(ROWS);
    await expect(loadStaff(db, 'rep@example.com', FIRST_ADMIN)).resolves.toEqual<Staff>({
      email: 'rep@example.com',
      role: 'rep',
      products: ['shytalk'],
    });
  });

  it('matches a staff row and its grants whatever the case of the stored email', async () => {
    const { db, queries } = standInDb(ROWS);
    await expect(loadStaff(db, 'MIXED@example.com', FIRST_ADMIN)).resolves.toEqual<Staff>({
      email: 'mixed@example.com',
      role: 'rep',
      products: ['yawelo-idle'],
    });
    for (const query of queries) {
      expect(query.sql).toMatch(/lower\(email\) = \?/);
      expect(query.values).toEqual(['mixed@example.com']);
    }
  });

  it('returns null for an email that is neither a staff row nor the first admin', async () => {
    const { db } = standInDb(ROWS);
    await expect(loadStaff(db, 'stranger@example.com', FIRST_ADMIN)).resolves.toBeNull();
  });

  it('returns null for a staff row with a role it does not know', async () => {
    const { db } = standInDb(ROWS);
    await expect(loadStaff(db, 'odd@example.com', FIRST_ADMIN)).resolves.toBeNull();
  });

  it('makes nobody the first admin when FIRST_ADMIN_EMAIL is empty', async () => {
    const { db } = standInDb({ staff: [], grants: [], products: ROWS.products });
    await expect(loadStaff(db, '', '')).resolves.toBeNull();
    await expect(loadStaff(db, 'stranger@example.com', '  ')).resolves.toBeNull();
  });

  it('returns null for an empty email even when it would match nothing else', async () => {
    const { db } = standInDb(ROWS);
    await expect(loadStaff(db, '   ', FIRST_ADMIN)).resolves.toBeNull();
  });
});

describe('scope', () => {
  const rep: Staff = { email: 'rep@example.com', role: 'rep', products: ['shytalk'] };
  const admin: Staff = { email: 'shyden@example.com', role: 'admin', products: ALL };

  it('gives a rep their grants when no product is asked for', () => {
    expect(scope(rep)).toEqual(['shytalk']);
  });

  it('gives a rep the product asked for when granted', () => {
    expect(scope(rep, 'shytalk')).toEqual(['shytalk']);
  });

  it('gives a rep nothing for a product not granted', () => {
    expect(scope(rep, 'yawelo-idle')).toEqual([]);
  });

  it('gives an admin every product when none is asked for', () => {
    expect(scope(admin)).toEqual(ALL);
  });

  it('gives an admin the one product asked for', () => {
    expect(scope(admin, 'yawelo-idle')).toEqual(['yawelo-idle']);
  });

  it('gives anyone nothing for a product that does not exist', () => {
    expect(scope(admin, 'no-such-product')).toEqual([]);
    expect(scope(rep, '')).toEqual([]);
  });

  it('returns a copy, so a caller cannot widen the staff record', () => {
    const result = scope(rep);
    result.push('yawelo-idle');
    expect(rep.products).toEqual(['shytalk']);
  });
});

describe('requireStaff', () => {
  const TEAM = 'shydesk-test.cloudflareaccess.com';
  const AUD = 'aud-tag-for-the-desk';
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

  function desk() {
    const app = new Hono<{ Bindings: StaffEnv; Variables: { staff: Staff } }>();
    app.use('/desk/*', requireStaff(jwks));
    app.get('/desk/me', (c) => c.json(c.var.staff));
    return app;
  }

  function env(): StaffEnv {
    return {
      DB: standInDb(ROWS).db,
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      FIRST_ADMIN_EMAIL: FIRST_ADMIN,
    };
  }

  it('lets a signed-in rep through with their staff record', async () => {
    const response = await desk().request('/desk/me', { headers: { 'Cf-Access-Jwt-Assertion': await sign('rep@example.com') } }, env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: 'rep@example.com', role: 'rep', products: ['shytalk'] });
  });

  it('answers 401 with no Access token, even with the email header', async () => {
    const response = await desk().request('/desk/me', { headers: { 'Cf-Access-Authenticated-User-Email': 'shyden@example.com' } }, env());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorised' });
  });

  it('answers 403 to someone Access let in who is not staff', async () => {
    const response = await desk().request(
      '/desk/me',
      { headers: { 'Cf-Access-Jwt-Assertion': await sign('stranger@example.com') } },
      env(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });

  it('passes on a database failure rather than turning it into a 401 or 403', async () => {
    const broken = {
      ...env(),
      DB: {
        prepare: () => {
          throw new Error('database down');
        },
      } as unknown as D1Database,
    };
    const app = desk();
    app.onError((error, c) => c.text(error.message, 500));
    const response = await app.request('/desk/me', { headers: { 'Cf-Access-Jwt-Assertion': await sign('rep@example.com') } }, broken);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('database down');
  });
});
