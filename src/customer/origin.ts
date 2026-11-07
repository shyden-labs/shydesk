import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.ts';
import { productForOrigin, type Product } from '../products.ts';
import { MESSAGES } from './messages.ts';

/** What /support-api handlers see: the product being asked about and the caller's IP. */
export interface CustomerEnv {
  Bindings: Env;
  Variables: { product: Product; clientIp: string };
}

/**
 * Admits a call to /support-api/*?product=<id> only from one of that
 * product's allowed origins (shyden-labs/shydesk#19). CORS names that exact
 * origin, never `*`. An unknown product, a missing or unlisted origin gets
 * 404 with no CORS header, so another page learns nothing, not even whether
 * the product exists. Answers the CORS preflight itself.
 */
export function requireProductOrigin(): MiddlewareHandler<CustomerEnv> {
  return async (c, next) => {
    const productId = c.req.query('product') ?? '';
    const origin = c.req.header('Origin') ?? '';
    const product = productId && origin ? await productForOrigin(c.env.DB, productId, origin) : null;
    if (!product) return c.json({ error: MESSAGES.notFound }, 404);
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST');
      c.header('Access-Control-Allow-Headers', 'Content-Type');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    c.set('product', product);
    c.set('clientIp', c.req.header('CF-Connecting-IP') ?? '');
    return next();
  };
}
