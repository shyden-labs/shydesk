import { describe, it, expect } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { app } from '../../src/index.ts';
import type { StaffEnv } from '../../src/auth/staff.ts';

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
