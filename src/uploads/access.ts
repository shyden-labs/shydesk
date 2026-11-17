import type { MiddlewareHandler } from 'hono';
import { MESSAGES } from '../customer/messages.ts';
import { requireProductOrigin, type CustomerEnv } from '../customer/origin.ts';
import { getProduct } from '../products.ts';
import { grantLive, useGrant } from '../reports/grants.ts';

const GRANT = /^Grant (\S+)$/;

/**
 * Who may use the upload endpoints (shyden-labs/shydesk#59). The product's own
 * support page, by its allowed origin, as in Release 1 (`requireProductOrigin`);
 * or a product's app holding an upload grant its server asked for, sent as
 * `Authorization: Grant <grant>`. A phone app sends no origin, so a live grant of
 * the product in `?product=` stands in for one. Starting an upload uses one of
 * the grant's files; its parts and finish only need the grant unexpired. A used
 * up, expired, unknown or other product's grant gets the same 404 as an unknown
 * origin. CORS names the origin only when it is one of the product's own.
 */
export function requireOriginOrGrant(): MiddlewareHandler<CustomerEnv> {
  const byOrigin = requireProductOrigin();
  return async (c, next) => {
    const grant = GRANT.exec(c.req.header('Authorization') ?? '')?.[1];
    if (grant === undefined) return byOrigin(c, next);
    const product = await getProduct(c.env.DB, c.req.query('product') ?? '');
    const starting = c.req.method === 'POST' && c.req.path === '/support-api/uploads';
    if (product === null) return c.json({ error: MESSAGES.notFound }, 404);
    const admitted = await (starting ? useGrant : grantLive)(c.env.DB, product.id, grant);
    if (!admitted) return c.json({ error: MESSAGES.notFound }, 404);
    const origin = c.req.header('Origin') ?? '';
    // The stored origin the request's matched, so nothing from the request is echoed (shyden-labs/shydesk#181).
    const allowed = product.allowedOrigins.find((listed) => listed === origin);
    if (allowed !== undefined) {
      c.header('Access-Control-Allow-Origin', allowed);
      c.header('Vary', 'Origin');
    }
    c.set('product', product);
    c.set('clientIp', c.req.header('CF-Connecting-IP') ?? '');
    return next();
  };
}
