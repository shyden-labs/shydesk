import { describe, it, expect } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { app } from '../../src/index.ts';
import type { Env } from '../../src/env.ts';

// The Worker's health check: what a deploy is read back with (shyden-labs/shydesk#14).
// The database is a stand-in: /health must answer without touching it.
const env: Env = { DB: {} as D1Database };

describe('GET /health', () => {
  it('answers 200 with {"ok":true} as JSON', async () => {
    const response = await app.request('/health', {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers only GET', async () => {
    const response = await app.request('/health', { method: 'POST' }, env);
    expect(response.status).toBe(404);
  });

  it('answers 404 for a path it does not serve', async () => {
    const response = await app.request('/nothing-here', {}, env);
    expect(response.status).toBe(404);
  });
});
