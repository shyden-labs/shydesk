import { Hono, type Context } from 'hono';
import { AppealRefused, createAppeal, findAppealable, parseAppeal } from '../appeals/appeals.ts';
import { hit } from '../limits.ts';
import { getProduct } from '../products.ts';
import { ReportError, createReport, parseReport } from '../reports/create.ts';
import { MAX_GRANT_FILES, createGrant } from '../reports/grants.ts';
import { getReport, offenderHistory } from '../reports/history.ts';
import { ticketLink } from '../tickets/create.ts';
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

/** Reports a product may send in one minute (Release 2 plan Task 3). */
const REPORTS_PER_MINUTE = 120;
/** In-product appeals share the reports' rate (shyden-labs/shydesk#61). */
const APPEALS_PER_MINUTE = 120;

async function jsonBody(c: Context<ApiEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
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

  // Release 2 reports (shyden-labs/shydesk#59): the product's server, never its app.
  app.post('/api/v1/products/:product/upload-grants', requireProductKey(), async (c) => {
    const body = await jsonBody(c);
    const count = typeof body === 'object' && body !== null ? (body as { count?: unknown }).count : undefined;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_GRANT_FILES) {
      return c.json({ error: 'bad_request' }, 400);
    }
    return c.json(await createGrant(c.env.DB, c.var.productId, count), 201);
  });

  app.post('/api/v1/products/:product/reports', requireProductKey(), async (c) => {
    if (!(await hit(c.env.DB, `reports:${c.var.productId}`, REPORTS_PER_MINUTE, 60))) return c.json({ error: 'rate_limited' }, 429);
    const report = parseReport(await jsonBody(c));
    if (report === null) return c.json({ error: 'bad_request' }, 400);
    try {
      return c.json({ report_id: await createReport(c.env.DB, c.var.productId, report) }, 202);
    } catch (error) {
      if (error instanceof ReportError) return c.json({ error: error.code }, 422);
      throw error;
    }
  });

  app.get('/api/v1/products/:product/reports/:id', requireProductKey(), async (c) => {
    const report = await getReport(c.env.DB, c.var.productId, c.req.param('id'));
    if (report === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ report, history: await offenderHistory(c.env.DB, c.var.productId, report.subject_user_id, report.id) });
  });

  // Release 2 appeals from inside the product (shyden-labs/shydesk#61): the same one-appeal rules as the ban notice link.
  app.post('/api/v1/products/:product/appeals', requireProductKey(), async (c) => {
    if (!(await hit(c.env.DB, `appeals:${c.var.productId}`, APPEALS_PER_MINUTE, 60))) return c.json({ error: 'rate_limited' }, 429);
    const body = await jsonBody(c);
    const punishmentId = typeof body === 'object' && body !== null ? (body as { punishment_id?: unknown }).punishment_id : undefined;
    const parsed = parseAppeal(body);
    if (typeof punishmentId !== 'string' || !parsed.ok) return c.json({ error: 'bad_request' }, 400);
    const tokenKey = c.env.TICKET_TOKEN_KEY;
    if (!tokenKey) {
      console.error('TICKET_TOKEN_KEY is not set: no appeal can be saved');
      return c.json({ error: 'unavailable' }, 503);
    }
    const found = await findAppealable(c.env.DB, c.var.productId, { punishmentId });
    const product = found === null ? null : await getProduct(c.env.DB, c.var.productId);
    if (found === null || product === null) return c.json({ error: 'not_found' }, 404);
    try {
      const { token } = await createAppeal(c.env.DB, found, parsed.value, tokenKey);
      return c.json({ ticket_url: ticketLink(product.ticketPageUrl, token) }, 201);
    } catch (error) {
      if (error instanceof AppealRefused) return c.json({ error: error.code }, 409);
      throw error;
    }
  });

  return app;
}
