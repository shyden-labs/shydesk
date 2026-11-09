import type { Fetcher } from '@cloudflare/workers-types';
import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import type { JWTVerifyGetKey } from 'jose';
import { requireStaff, scope, type Staff, type StaffEnv } from '../auth/staff.ts';
import { sendNoReply, type Deliver, type MailEnv, type NoticeResult } from '../mail/notify.ts';
import { getProduct, listCanned, listProducts, type Canned } from '../products.ts';
import { ticketLink } from '../tickets/create.ts';
import { openToken } from '../tickets/seal.ts';
import { changeStatus, type TimerEnv } from '../tickets/status.ts';
import { getTicket, listTickets, markRead, unreadCount, type DeskTicket } from './queries.ts';
import { listPage, ticketPage } from './views.ts';

/**
 * The staff desk under /desk (shyden-labs/shydesk#24; plan Task 10). Signed-in
 * staff only, each limited to their products: a ticket outside them is 404, and
 * another product's filter lists nothing. Posts must come from this origin. A
 * reply is kept even when its email cannot go; the page says what happened.
 */

export interface DeskBindings extends StaffEnv, TimerEnv, MailEnv {
  ASSETS: Fetcher;
  TICKET_TOKEN_KEY?: string;
}

export interface DeskDeps {
  deliver: Deliver;
}

type DeskEnv = { Bindings: DeskBindings; Variables: { staff: Staff } };
type DeskContext = Context<DeskEnv>;
type MailResult = NoticeResult | 'no-link';

const MAX_REPLY = 10_000;
const STATUSES = ['open', 'waiting', 'closed'];

const reference = (c: DeskContext, name: string): string | undefined => c.req.query(name) || undefined;

/** Emails the customer the ticket's unchanged private link. Never throws: the reply is already saved. */
async function notifyCustomer(c: DeskContext, deliver: Deliver, ticket: DeskTicket, now: number): Promise<MailResult> {
  if (ticket.token_sealed === null) return 'no-link';
  const key = c.env.TICKET_TOKEN_KEY;
  if (!key) {
    console.error('TICKET_TOKEN_KEY is not set: no reply email can carry its link');
    return 'failed';
  }
  let token: string;
  try {
    token = await openToken(key, ticket.token_sealed);
  } catch (error) {
    console.error(`ticket ${ticket.id}: its private link could not be opened: ${(error as Error).message}`);
    return 'failed';
  }
  const product = await getProduct(c.env.DB, ticket.product_id);
  if (product === null) return 'failed';
  return sendNoReply(c.env, product, ticket.customer_email, ticketLink(product.ticketPageUrl, token), deliver, new Date(now));
}

export function deskRoutes(deps: DeskDeps, jwks?: JWTVerifyGetKey): Hono<DeskEnv> {
  const app = new Hono<DeskEnv>();

  // The page's script holds nothing private, and comes from the static assets.
  app.get('/desk.js', (c) => c.env.ASSETS.fetch(c.req.raw as never) as unknown as Promise<Response>);

  app.use('/desk/*', requireStaff(jwks));
  app.use('/desk/*', csrf());

  app.get('/desk', async (c) => {
    const staff = c.var.staff;
    const selected = reference(c, 'product');
    const statusAsked = reference(c, 'status');
    const status = statusAsked !== undefined && STATUSES.includes(statusAsked) ? statusAsked : undefined;
    const typeId = reference(c, 'type');
    const asked = Number(c.req.query('cursor'));
    const cursor = Number.isInteger(asked) && asked > 0 ? asked : 0;
    const inScope = scope(staff, selected);
    const allProducts = await listProducts(c.env.DB);
    const products = allProducts.filter((p) => staff.products.includes(p.id));
    const { results: types } =
      inScope.length === 0
        ? { results: [] }
        : await c.env.DB.prepare(
            `SELECT id, name FROM ticket_types WHERE product_id IN (${inScope.map(() => '?').join(', ')}) ORDER BY name`,
          )
            .bind(...inScope)
            .all<{ id: string; name: string }>();
    return c.html(
      listPage({
        products: products.map((p) => ({ id: p.id, name: p.name })),
        selected,
        showAll: staff.role === 'admin',
        status,
        typeId,
        types,
        tickets: await listTickets(c.env.DB, inScope, { status, typeId, cursor }),
        cursor,
        productNames: new Map(allProducts.map((p) => [p.id, p.name])),
      }),
    );
  });

  app.get('/desk/api/unread', async (c) => c.json({ count: await unreadCount(c.env.DB, c.var.staff.email, c.var.staff.products) }));

  app.get('/desk/tickets/:id', async (c) => {
    const staff = c.var.staff;
    const found = await getTicket(c.env.DB, staff.products, c.req.param('id'));
    if (found === null) return c.notFound();
    await markRead(c.env.DB, staff, found.ticket.id);
    const canned: Canned[] = (await listCanned(c.env.DB, found.ticket.product_id)).filter(
      (one) => one.typeId === null || one.typeId === found.ticket.type_id,
    );
    return c.html(ticketPage({ ...found, canned, mail: reference(c, 'mail'), error: reference(c, 'error') }));
  });

  app.post('/desk/tickets/:id/reply', async (c) => {
    const staff = c.var.staff;
    const found = await getTicket(c.env.DB, staff.products, c.req.param('id'));
    if (found === null) return c.notFound();
    const { ticket } = found;
    const form = await c.req.parseBody();
    const body = typeof form.body === 'string' ? form.body : '';
    if (body.trim() === '' || body.length > MAX_REPLY) return c.redirect(`/desk/tickets/${ticket.id}?error=empty`, 303);
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES (?, ?, 'staff', ?, ?, ?)")
      .bind(crypto.randomUUID(), ticket.id, staff.email, body, now)
      .run();
    await changeStatus(c.env, ticket.id, 'waiting', now);
    const mail = await notifyCustomer(c, deps.deliver, ticket, now);
    return c.redirect(`/desk/tickets/${ticket.id}?mail=${mail}`, 303);
  });

  app.post('/desk/tickets/:id/close', async (c) => {
    const found = await getTicket(c.env.DB, c.var.staff.products, c.req.param('id'));
    if (found === null) return c.notFound();
    await changeStatus(c.env, found.ticket.id, 'closed', Date.now());
    return c.redirect(`/desk/tickets/${found.ticket.id}`, 303);
  });

  return app;
}
