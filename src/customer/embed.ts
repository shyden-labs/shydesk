import type { Fetcher } from '@cloudflare/workers-types';
import { Hono, type Context } from 'hono';

/** What /embed.js needs: the static assets (wrangler.jsonc `assets`). */
export interface EmbedEnv {
  ASSETS: Fetcher;
}

/**
 * Serves the shared piece (shyden-labs/shydesk#19), built into the static
 * assets from public/embed.js, at /embed.js. Any page may load it: a script
 * tag needs no CORS, and Cross-Origin-Resource-Policy: cross-origin lets
 * pages that isolate themselves load it too. It is cached for five minutes,
 * after which the assets' ETag (a hash of the content) makes a check cheap.
 * A missing asset is passed on unchanged and never cached.
 */
export function embedRoutes(): Hono<{ Bindings: EmbedEnv }> {
  const routes = new Hono<{ Bindings: EmbedEnv }>();
  const serve = async (c: Context<{ Bindings: EmbedEnv }>): Promise<Response> => {
    const asset = (await c.env.ASSETS.fetch(c.req.raw as never)) as unknown as Response;
    if (!asset.ok) return asset;
    const served = new Response(asset.body, asset);
    served.headers.set('Cache-Control', 'public, max-age=300');
    served.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    served.headers.set('X-Content-Type-Options', 'nosniff');
    return served;
  };
  routes.get('/embed.js', serve);
  // The piece's media code (shyden-labs/shydesk#21): a cross-origin import needs CORS, and any page may load the piece.
  const serveImported = async (c: Context<{ Bindings: EmbedEnv }>): Promise<Response> => {
    const served = await serve(c);
    if (served.ok) served.headers.set('Access-Control-Allow-Origin', '*');
    return served;
  };
  routes.get('/embed-media.js', serveImported);
  routes.get('/embed-video.js', serveImported);
  return routes;
}
