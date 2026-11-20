import { Hono } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import type { Fetcher } from '@cloudflare/workers-types';
import { requireStaff, type Staff, type StaffEnv } from '../auth/staff.ts';

/** The docs need the staff settings and the static assets (wrangler.jsonc `assets`). */
export interface DocsEnv extends StaffEnv {
  ASSETS: Fetcher;
  /** "true" on the Non-Prod deploy only (wrangler.jsonc `env.dev.vars`): staff may try requests that write there. */
  TRY_WRITES?: string;
}

// Swagger UI styles itself with inline style attributes; nothing else is allowed in.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

/** The spec's server list: replaced, for each host, by that host alone (shyden-labs/shydesk#83). */
const SERVERS = /^servers:\n(?: {2}.*\n)+/m;
/** What Swagger UI may send from "Try it out": every method on Non-Prod, reads only anywhere else. */
const ALL_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

/**
 * The API docs (shyden-labs/shydesk#26): a self-hosted Swagger UI showing
 * openapi/shydesk.v1.yaml at /api/docs/, for staff only. `npm run build:docs`
 * (wrangler's build step) puts the page, the Swagger UI files and the spec in
 * the static assets; every request reaches this Worker first
 * (`run_worker_first`), so nothing is served before Access and the staff check.
 */
export function docsRoutes(jwks?: JWTVerifyGetKey): Hono<{ Bindings: DocsEnv; Variables: { staff: Staff } }> {
  const app = new Hono<{ Bindings: DocsEnv; Variables: { staff: Staff } }>();
  app.use('/api/docs', requireStaff(jwks));
  app.use('/api/docs/*', requireStaff(jwks));
  app.get('/api/docs', (c) => c.redirect('/api/docs/', 301));
  // Each host's docs offer that host as their server, so Non-Prod's never send a request to live (shyden-labs/shydesk#83).
  app.get('/api/docs/shydesk.v1.yaml', async (c) => {
    const asset = (await c.env.ASSETS.fetch(c.req.raw as never)) as unknown as Response;
    const spec = await asset.text();
    if (!SERVERS.test(spec)) return c.text('openapi/shydesk.v1.yaml has no servers block to replace with this host', 500, PRIVATE);
    const origin = new URL(c.req.url).origin;
    return c.text(spec.replace(SERVERS, `servers:\n  - url: ${origin}\n    description: This host\n`), 200, {
      ...PRIVATE,
      'Content-Type': 'text/yaml; charset=utf-8',
    });
  });
  // Only the Non-Prod deploy lets staff try requests that write, such as creating a ticket.
  app.get('/api/docs/try.json', (c) => c.json({ methods: c.env.TRY_WRITES === 'true' ? ALL_METHODS : ['get'] }, 200, PRIVATE));
  app.get('/api/docs/*', async (c) => {
    const asset = (await c.env.ASSETS.fetch(c.req.raw as never)) as unknown as Response;
    const response = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(PRIVATE)) response.headers.set(name, value);
    response.headers.set('Content-Security-Policy', CSP);
    return response;
  });
  return app;
}
