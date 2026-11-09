import { describe, it, expect } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { app, noSmtpYet } from '../../src/index.ts';
import type { StaffEnv } from '../../src/auth/staff.ts';
import { standInDb } from './d1-stand-in.ts';

// The Worker serves the admin screen (shyden-labs/shydesk#17). Until Access is
// configured on a deploy (shyden-labs/shydesk#13), /admin refuses everyone
// with 401 and never reads the database.
const unconfigured: StaffEnv = { DB: {} as D1Database, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', FIRST_ADMIN_EMAIL: '' };

describe('/admin on the Worker', () => {
  it('is served, and refuses a request with no Access token with 401', async () => {
    expect((await app.request('/admin', {}, unconfigured)).status).toBe(401);
  });

  it('refuses a forged Access token with 401 while Access is not configured', async () => {
    const response = await app.request('/admin/staff', { headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } }, unconfigured);
    expect(response.status).toBe(401);
  });
});

// The product API (shyden-labs/shydesk#26) is mounted on the Worker: a call
// with no key is refused with 401 before any database read.
describe('/api/v1 on the Worker', () => {
  it('is served, and refuses a feed request with no API key with 401', async () => {
    const response = await app.request('/api/v1/products/shytalk/feed', {}, unconfigured);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'A valid API key is required.' });
  });
});

// The API docs (shyden-labs/shydesk#26) are mounted on the Worker behind the
// staff check: with Access not configured, everyone gets 401.
describe('/api/docs on the Worker', () => {
  it('is served, and refuses a request with no Access token with 401', async () => {
    expect((await app.request('/api/docs/', {}, unconfigured)).status).toBe(401);
  });
});

// The customer API and the shared piece (shyden-labs/shydesk#19) are mounted
// on the Worker: a product's own origin gets its form settings, and the
// piece is served from the static assets.
describe('/support-api and /embed.js on the Worker', () => {
  const { db } = standInDb((sql) =>
    sql.includes('FROM products')
      ? [
          {
            id: 'shytalk',
            name: 'ShyTalk',
            sender_address: 'n@shytalk.app',
            ticket_page_url: 'https://shytalk.app/t',
            allowed_origins_json: '["https://shytalk.app"]',
            monthly_email_share: 1,
            attachments_keep_days: 30,
            text_keep_days: 365,
            privacy_url_en: 'https://example.com/privacy',
            privacy_url_id: 'https://example.com/id/privacy',
            created_at: 1,
          },
        ]
      : [],
  );
  const env = { ...unconfigured, DB: db, ASSETS: { fetch: () => Promise.resolve(new Response('/* piece */')) } };

  it("answers a product's own origin with the form settings and that origin in CORS", async () => {
    const response = await app.request('/support-api/config?product=shytalk', { headers: { Origin: 'https://shytalk.app' } }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://shytalk.app');
  });

  it('serves the piece', async () => {
    const response = await app.request('/embed.js', {}, env);
    expect(await response.text()).toBe('/* piece */');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });
});

// Until shyden-labs/shydesk#68 opens a real SMTP connection, every notice
// fails by name, so the piece tells the customer to keep the private link.
describe('the Worker mail delivery', () => {
  it('refuses every send, naming the story that adds the connection', async () => {
    await expect(noSmtpYet({ user: 'u', pass: 'p' }, { from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't' })).rejects.toThrow(
      'shyden-labs/shydesk#68',
    );
  });
});
