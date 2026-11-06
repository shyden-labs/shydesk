import { Hono } from 'hono';
import { requireProductKey, type ApiEnv } from './auth.ts';

/** One ticket as a product server sees it in the feed: no customer details, no message text. */
export interface TicketSummary {
  id: string;
  status: 'open' | 'waiting' | 'closed';
  subject: string;
  category: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  seq: number;
}

const WHOLE = /^\d+$/;

/** A query value as a whole number within [min, max], or null. */
function wholeNumber(value: string, min: number, max: number): number | null {
  if (!WHOLE.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * The product API (shyden-labs/shydesk#26), described in
 * openapi/shydesk.v1.yaml. `GET /api/v1/products/{product}/feed` returns the
 * product's new and changed tickets oldest change first. Every change gives a
 * ticket the next `seq`, so paging with `seq > since_cursor` returns each
 * change once; `next_cursor` is the last seq returned, or the cursor sent.
 */
export function apiRoutes(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/v1/products/:product/feed', requireProductKey(), async (c) => {
    const since = wholeNumber(c.req.query('since_cursor') ?? '0', 0, Number.MAX_SAFE_INTEGER);
    if (since === null) return c.json({ error: 'since_cursor must be a whole number from 0.' }, 400);
    const limit = wholeNumber(c.req.query('limit') ?? '50', 1, 100);
    if (limit === null) return c.json({ error: 'limit must be a whole number from 1 to 100.' }, 400);

    const { results } = await c.env.DB.prepare(
      `SELECT id, status, subject, category, created_at, updated_at, closed_at, seq
       FROM tickets WHERE product_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
      .bind(c.var.productId, since, limit)
      .all<TicketSummary>();
    const items = results.map((t) => ({
      id: t.id,
      status: t.status,
      subject: t.subject,
      category: t.category,
      created_at: t.created_at,
      updated_at: t.updated_at,
      closed_at: t.closed_at,
      seq: t.seq,
    }));
    return c.json({ items, next_cursor: items.at(-1)?.seq ?? since });
  });

  return app;
}
