import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.ts';
import { hashKey } from '../products.ts';

/** What /api/v1 handlers see: the product the caller's key belongs to. */
export interface ApiEnv {
  Bindings: Env;
  Variables: { productId: string };
}

const BEARER = /^Bearer (\S+)$/;

/**
 * Admits a product server calling /api/v1/products/:product/... with
 * `Authorization: Bearer <key>` (shyden-labs/shydesk#26). The key is looked up
 * by its hash only. No key, an unknown key or a revoked key gets 401; a live
 * key of another product gets 404, so a key never learns which products exist.
 */
export function requireProductKey(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const key = BEARER.exec(c.req.header('Authorization') ?? '')?.[1];
    const row = key
      ? await c.env.DB.prepare('SELECT product_id, revoked_at FROM api_keys WHERE hash = ?')
          .bind(await hashKey(key))
          .first<{ product_id: string; revoked_at: number | null }>()
      : null;
    if (!row || row.revoked_at !== null) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'A valid API key is required.' }, 401);
    }
    if (row.product_id !== c.req.param('product')) return c.json({ error: 'Not found.' }, 404);
    c.set('productId', row.product_id);
    return next();
  };
}
