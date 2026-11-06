import { Hono } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import type { Fetcher } from '@cloudflare/workers-types';
import { requireStaff, type Staff, type StaffEnv } from '../auth/staff.ts';

/** The docs need the staff settings and the static assets (wrangler.jsonc `assets`). */
export interface DocsEnv extends StaffEnv {
  ASSETS: Fetcher;
}

// Swagger UI styles itself with inline style attributes; nothing else is allowed in.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

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
  app.get('/api/docs/*', async (c) => {
    const asset = (await c.env.ASSETS.fetch(c.req.raw as never)) as unknown as Response;
    const response = new Response(asset.body, asset);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Content-Security-Policy', CSP);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  });
  return app;
}
