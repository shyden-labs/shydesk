import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireProductOrigin, type CustomerEnv } from '../../src/customer/origin.ts';
import { standInDb } from './d1-stand-in.ts';

// The customer API answers only a known product called from one of its own
// allowed origins (shyden-labs/shydesk#19). CORS names that exact origin,
// never `*`; anything else is a 404 with no CORS header, so a page elsewhere
// learns nothing, not even whether the product exists.
const SHYTALK = {
  id: 'shytalk',
  name: 'ShyTalk',
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: JSON.stringify(['https://shytalk.app', 'https://www.shytalk.app']),
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
};

function appWith() {
  const { db } = standInDb((sql, values) => (sql.includes('FROM products') && values[0] === 'shytalk' ? [SHYTALK] : []));
  const app = new Hono<CustomerEnv>();
  app.use('/support-api/*', requireProductOrigin());
  app.get('/support-api/whoami', (c) => c.json({ product: c.var.product.id, ip: c.var.clientIp }));
  app.post('/support-api/whoami', (c) => c.json({ product: c.var.product.id }));
  const call = (path: string, init: RequestInit = {}) => app.request(path, init, { DB: db });
  return { call };
}

const from = (origin: string, extra: Record<string, string> = {}) => ({ headers: { Origin: origin, ...extra } });

describe('requireProductOrigin', () => {
  it('lets an allowed origin through, naming the product and the client IP, with that exact origin in CORS', async () => {
    const { call } = appWith();
    const response = await call(
      '/support-api/whoami?product=shytalk',
      from('https://www.shytalk.app', { 'CF-Connecting-IP': '203.0.113.9' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: 'shytalk', ip: '203.0.113.9' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.shytalk.app');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('answers a preflight from an allowed origin with that origin, the methods and the content-type header', async () => {
    const { call } = appWith();
    const response = await call('/support-api/whoami?product=shytalk', {
      method: 'OPTIONS',
      ...from('https://shytalk.app', { 'Access-Control-Request-Method': 'POST' }),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://shytalk.app');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it.each([
    ['an unknown product', '/support-api/whoami?product=nope', from('https://shytalk.app')],
    ['an origin not on the list', '/support-api/whoami?product=shytalk', from('https://evil.example')],
    ['a near-miss origin with a port', '/support-api/whoami?product=shytalk', from('https://shytalk.app:8443')],
    ['no product named', '/support-api/whoami', from('https://shytalk.app')],
    ['no Origin header', '/support-api/whoami?product=shytalk', {}],
  ])('answers %s with 404 and no CORS header', async (_case, path, init) => {
    const { call } = appWith();
    const response = await call(path, init);
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('refuses a preflight from an origin not on the list with 404 and no CORS header', async () => {
    const { call } = appWith();
    const response = await call('/support-api/whoami?product=shytalk', { method: 'OPTIONS', ...from('https://evil.example') });
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('names an empty client IP when Cloudflare sent none', async () => {
    const { call } = appWith();
    const response = await call('/support-api/whoami?product=shytalk', from('https://shytalk.app'));
    expect(await response.json()).toEqual({ product: 'shytalk', ip: '' });
  });
});
