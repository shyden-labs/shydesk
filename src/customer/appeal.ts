import { Hono, type Context } from 'hono';
import { AppealRefused, appealStatus, createAppeal, findAppealable, parseAppeal } from '../appeals/appeals.ts';
import type { Env } from '../env.ts';
import { hit } from '../limits.ts';
import { sendNoReply, type Deliver } from '../mail/notify.ts';
import type { Product } from '../products.ts';
import { ticketLink } from '../tickets/create.ts';
import { MESSAGES } from './messages.ts';
import { requireProductOrigin } from './origin.ts';

/**
 * The shared piece's appeal view (shyden-labs/shydesk#61; Release 2 plan Task 5).
 * The ban notice links to `<product appeal page>#appeal=<token>`; the piece reads
 * the token from the fragment and sends it only in the `ShyDesk-Appeal` header,
 * so it is in no URL or server log:
 *
 * - `GET /support-api/appeals?product=<id>`: the punishment's label and date, and
 *   whether it can still be appealed (`already_appealed`, `lifted` if not).
 * - `POST /support-api/appeals?product=<id>` with `{ email, message }`: the appeal,
 *   at most 20 per client IP per hour. Answers 201 with the private ticket link,
 *   mailed to the appellant too, or 409 naming why no appeal is taken.
 */

const APPEALS_PER_HOUR = 20;
const HOUR = 3600;

export interface AppealBindings extends Env {
  TICKET_TOKEN_KEY?: string;
  SMTP_LOGINS?: string;
  SMTP_HOST?: string;
}

interface AppealEnv {
  Bindings: AppealBindings;
  Variables: { product: Product; clientIp: string };
}

const tokenOf = (c: Context<AppealEnv>): string => c.req.header('ShyDesk-Appeal') ?? '';

export function appealRoutes(deps: { deliver: Deliver }): Hono<AppealEnv> {
  const app = new Hono<AppealEnv>();
  app.use('/support-api/appeals', requireProductOrigin());

  app.get('/support-api/appeals', async (c) => {
    const found = await findAppealable(c.env.DB, c.var.product.id, { token: tokenOf(c) });
    if (found === null) return c.json({ error: MESSAGES.notFound }, 404);
    return c.json(appealStatus(found));
  });

  app.post('/support-api/appeals', async (c) => {
    const product = c.var.product;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: MESSAGES.badRequest }, 400);
    }
    const parsed = parseAppeal(body);
    if ('unreadable' in parsed) return c.json({ error: MESSAGES.badRequest }, 400);
    if (!parsed.ok) return c.json({ errors: parsed.errors }, 400);
    const tokenKey = c.env.TICKET_TOKEN_KEY;
    if (!tokenKey) {
      console.error('TICKET_TOKEN_KEY is not set: no appeal can be saved');
      return c.json({ error: MESSAGES.unavailable }, 503);
    }
    const now = Date.now();
    if (!(await hit(c.env.DB, `appeal:ip:${c.var.clientIp}`, APPEALS_PER_HOUR, HOUR, now))) {
      return c.json({ error: MESSAGES.tooMany }, 429);
    }
    const found = await findAppealable(c.env.DB, product.id, { token: tokenOf(c) });
    if (found === null) return c.json({ error: MESSAGES.notFound }, 404);
    let token: string;
    try {
      ({ token } = await createAppeal(c.env.DB, found, parsed.value, tokenKey, now));
    } catch (error) {
      if (error instanceof AppealRefused) return c.json({ error: error.code }, 409);
      throw error;
    }
    const link = ticketLink(product.ticketPageUrl, token);
    const mailed = await sendNoReply(c.env, product, parsed.value.email, link, deps.deliver, new Date(now));
    return c.json({ ticket_url: link, email_sent: mailed === 'sent' }, 201);
  });

  return app;
}
