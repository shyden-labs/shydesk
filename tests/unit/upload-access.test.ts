import type { D1Database } from '@cloudflare/workers-types';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../src/customer/messages.ts';
import { hashKey } from '../../src/products.ts';
import { requireOriginOrGrant } from '../../src/uploads/access.ts';
import { standInDb, type Answer, type Statement } from './d1-stand-in.ts';

// Who may use the upload endpoints (shyden-labs/shydesk#59): the product's own
// support page, by its allowed origin as in Release 1, or a product's app holding
// an upload grant its server asked for. A phone app sends no origin, so a live
// grant of that product stands in for it. Starting an upload uses one of the
// grant's files; its parts and its finish only need the grant to be unexpired.

const ORIGIN = 'https://shytalk.app';
const PRODUCT = {
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

async function world(grant: { left: number; live: boolean } | null) {
  const key = `grant:shytalk:${await hashKey('the-grant')}`;
  const answer: Answer = (sql, values) => {
    if (sql.includes('FROM products')) return ['shytalk', 'yawelo-idle'].includes(String(values[0])) ? [{ ...PRODUCT, id: values[0] }] : [];
    if (grant === null || values[0] !== key || !grant.live) return [];
    if (sql.includes('UPDATE counters SET value = value - 1')) {
      if (grant.left === 0) return [];
      grant.left -= 1;
      return [{ value: grant.left }];
    }
    if (sql.includes('SELECT value FROM counters')) return [{ value: grant.left }];
    return [];
  };
  const { db, statements } = standInDb(answer);
  const app = new Hono<{ Bindings: { DB: D1Database }; Variables: { product: { id: string }; clientIp: string } }>();
  app.use('/support-api/uploads/*', requireOriginOrGrant());
  app.all('/support-api/uploads/*', (c) => c.json({ product: c.var.product.id, ip: c.var.clientIp }));
  const call = (path: string, method: string, headers: Record<string, string>, productId = 'shytalk') =>
    app.request(`${path}?product=${productId}`, { method, headers: { 'CF-Connecting-IP': '203.0.113.9', ...headers } }, { DB: db });
  /** A request exactly as given: no product query and no IP header added. */
  const raw = (url: string, method: string, headers: Record<string, string>) => app.request(url, { method, headers }, { DB: db });
  return { call, raw, statements, grant };
}

const uses = (statements: Statement[]) => statements.filter((s) => s.sql.includes('UPDATE counters SET value = value - 1'));
const GRANT = { Authorization: 'Grant the-grant' };

describe('an upload grant', () => {
  it('starts an upload with no origin, using one file', async () => {
    const w = await world({ left: 2, live: true });
    const response = await w.call('/support-api/uploads', 'POST', GRANT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: 'shytalk', ip: '203.0.113.9' });
    expect(uses(w.statements)).toHaveLength(1);
    expect(w.grant?.left).toBe(1);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('refuses a start once its files are used up, as an unknown caller', async () => {
    const w = await world({ left: 0, live: true });
    const response = await w.call('/support-api/uploads', 'POST', GRANT);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: MESSAGES.notFound });
  });

  it('sends parts and finishes under a live grant without using a file', async () => {
    const w = await world({ left: 0, live: true });
    expect((await w.call('/support-api/uploads/u1/parts/1', 'PUT', GRANT)).status).toBe(200);
    expect((await w.call('/support-api/uploads/u1/complete', 'POST', GRANT)).status).toBe(200);
    expect(uses(w.statements)).toEqual([]);
  });

  it('refuses parts after 15 minutes', async () => {
    const w = await world({ left: 3, live: false });
    expect((await w.call('/support-api/uploads/u1/parts/1', 'PUT', GRANT)).status).toBe(404);
  });

  it('refuses a grant for a product that does not exist', async () => {
    const w = await world({ left: 3, live: true });
    expect((await w.call('/support-api/uploads', 'POST', GRANT, 'ghost')).status).toBe(404);
    expect(uses(w.statements)).toEqual([]);
  });

  it("refuses a grant on another product's uploads", async () => {
    const w = await world({ left: 3, live: true });
    expect((await w.call('/support-api/uploads', 'POST', GRANT, 'yawelo-idle')).status).toBe(404);
  });

  it("names the product's own origin in CORS when the grant comes from its page", async () => {
    const w = await world({ left: 3, live: true });
    const response = await w.call('/support-api/uploads', 'POST', { ...GRANT, Origin: ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('gives no CORS header to another origin holding a grant', async () => {
    const w = await world({ left: 3, live: true });
    const response = await w.call('/support-api/uploads', 'POST', { ...GRANT, Origin: 'https://evil.example' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('with no grant', () => {
  it("admits the product's own origin, as in Release 1", async () => {
    const w = await world(null);
    const response = await w.call('/support-api/uploads', 'POST', { Origin: ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('refuses a call with no origin and no grant', async () => {
    const w = await world(null);
    expect((await w.call('/support-api/uploads', 'POST', {})).status).toBe(404);
  });

  it('treats a Bearer token as no grant', async () => {
    const w = await world({ left: 3, live: true });
    expect((await w.call('/support-api/uploads', 'POST', { Authorization: 'Bearer the-grant' })).status).toBe(404);
    expect(uses(w.statements)).toEqual([]);
  });
});

describe('grant edges', () => {
  it('refuses a grant with no product named, using nothing', async () => {
    const w = await world({ left: 3, live: true });
    expect((await w.raw('/support-api/uploads', 'POST', GRANT)).status).toBe(404);
    expect(uses(w.statements)).toEqual([]);
  });

  it('admits a grant from a caller with no IP header, counting it under an empty address', async () => {
    const w = await world({ left: 3, live: true });
    const response = await w.raw('/support-api/uploads?product=shytalk', 'POST', GRANT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: 'shytalk', ip: '' });
  });
});
