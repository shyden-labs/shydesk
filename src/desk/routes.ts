import type { Fetcher, R2Bucket } from '@cloudflare/workers-types';
import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import type { JWTVerifyGetKey } from 'jose';
import { AppealNotFound, AppealRefused, decideAppeal } from '../appeals/appeals.ts';
import { requireStaff, scope, type Staff, type StaffEnv } from '../auth/staff.ts';
import { sendNoReply, type Deliver, type MailEnv, type NoticeResult } from '../mail/notify.ts';
import { getProduct, listCanned, listProducts, type Canned } from '../products.ts';
import { ticketLink } from '../tickets/create.ts';
import { openToken } from '../tickets/seal.ts';
import { changeStatus, type TimerEnv } from '../tickets/status.ts';
import { streamFile } from '../uploads/serve.ts';
import {
  PunishmentNotFound,
  PunishmentRefused,
  applyPunishment,
  findPunishment,
  liftPunishment,
  resendPunishment,
} from '../punishments/apply.ts';
import type { Fetcher as CallbackFetcher } from '../punishments/send.ts';
import { appealPanel, getFile, getTicket, listTickets, markRead, reportPanel, unreadCount, type DeskTicket } from './queries.ts';
import { listPage, ticketPage } from './views.ts';
import {
  HoldNotFound,
  HoldRefused,
  legalReview,
  liftHold,
  placeHold,
  recordAuthorityReport,
  recordNoReport,
  renewHold,
  setOrderPending,
  ticketHolds,
} from '../holds/holds.ts';

/**
 * The staff desk under /desk (shyden-labs/shydesk#24; plan Task 10). Signed-in
 * staff only, each limited to their products: a ticket outside them is 404, and
 * another product's filter lists nothing. Posts must come from this origin. A
 * reply is kept even when its email cannot go; the page says what happened.
 */

export interface DeskBindings extends StaffEnv, TimerEnv, MailEnv {
  ASSETS: Fetcher;
  FILES: R2Bucket;
  TICKET_TOKEN_KEY?: string;
}

export interface DeskDeps {
  deliver: Deliver;
  /** How punishments reach the product (shyden-labs/shydesk#60); `fetch` unless a test stands in. */
  fetcher?: CallbackFetcher;
}

type DeskEnv = { Bindings: DeskBindings; Variables: { staff: Staff } };
type DeskContext = Context<DeskEnv>;
type MailResult = NoticeResult | 'no-link';

const MAX_REPLY = 10_000;
const STATUSES = new Set(['open', 'waiting', 'closed']);

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
    const status = statusAsked !== undefined && STATUSES.has(statusAsked) ? statusAsked : undefined;
    const typeId = reference(c, 'type');
    const asked = Number(c.req.query('cursor'));
    const cursor = Number.isInteger(asked) && asked > 0 ? asked : 0;
    const inScope = scope(staff, selected);
    const allProducts = await listProducts(c.env.DB);
    const products = allProducts.filter((p) => staff.products.includes(p.id));
    const placeholders = inScope.map(() => '?').join(', ');
    const appeals = staff.role === 'admin' ? '' : " AND kind != 'appeal'";
    const { results: types } =
      inScope.length === 0
        ? { results: [] }
        : await c.env.DB.prepare(`SELECT id, name FROM ticket_types WHERE product_id IN (${placeholders})${appeals} ORDER BY name`)
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
        tickets: await listTickets(c.env.DB, { products: inScope, role: staff.role }, { status, typeId, cursor }),
        cursor,
        productNames: new Map(allProducts.map((p) => [p.id, p.name])),
        legal: await legalReview(c.env.DB, staff, Date.now()),
      }),
    );
  });

  app.get('/desk/api/unread', async (c) => c.json({ count: await unreadCount(c.env.DB, c.var.staff.email, c.var.staff) }));

  app.get('/desk/tickets/:id', async (c) => {
    const staff = c.var.staff;
    const found = await getTicket(c.env.DB, staff, c.req.param('id'));
    if (found === null) return c.notFound();
    await markRead(c.env.DB, staff, found.ticket.id);
    const canned: Canned[] = (await listCanned(c.env.DB, found.ticket.product_id)).filter(
      (one) => one.typeId === null || one.typeId === found.ticket.type_id,
    );
    return c.html(
      ticketPage({
        ...found,
        canned,
        mail: reference(c, 'mail'),
        error: reference(c, 'error'),
        report: await reportPanel(c.env.DB, found.ticket),
        punishment: reference(c, 'punishment'),
        // A rep never gets here with an appeal: getTicket leaves appeals out for them in SQL.
        appeal: await appealPanel(c.env.DB, found.ticket),
        appealOutcome: reference(c, 'appeal'),
        isAdmin: staff.role === 'admin',
        holds: await ticketHolds(c.env.DB, staff, found.ticket.id),
        holdDone: reference(c, 'hold'),
      }),
    );
  });

  // Release 2 punishments (shyden-labs/shydesk#60). Out of scope, and a rep lifting, is 404.
  const punishmentAction = async (c: DeskContext, act: () => Promise<{ report_ticket_id: string; state: string }>, back: string) => {
    try {
      const done = await act();
      return c.redirect(`/desk/tickets/${done.report_ticket_id}?punishment=${done.state}`, 303);
    } catch (error) {
      if (error instanceof PunishmentNotFound) return c.notFound();
      if (error instanceof PunishmentRefused) return c.redirect(`/desk/tickets/${back}?error=${error.code}`, 303);
      throw error;
    }
  };

  app.post('/desk/tickets/:id/punish', async (c) => {
    const ticketId = c.req.param('id');
    const form = await c.req.parseBody();
    const key = typeof form.key === 'string' ? form.key : '';
    return punishmentAction(
      c,
      async () => {
        const row = await applyPunishment(c.env, c.var.staff, ticketId, key, deps.fetcher);
        return { report_ticket_id: row.report_ticket_id, state: row.send_state };
      },
      ticketId,
    );
  });

  for (const [action, run] of [
    ['resend', resendPunishment],
    ['lift', liftPunishment],
  ] as const) {
    app.post(`/desk/punishments/:id/${action}`, async (c) => {
      const staff = c.var.staff;
      const found = await findPunishment(c.env.DB, staff, c.req.param('id'));
      if (found === null) return c.notFound();
      return punishmentAction(
        c,
        async () => ({ report_ticket_id: found.report_ticket_id, state: await run(c.env, staff, found.id, deps.fetcher) }),
        found.report_ticket_id,
      );
    });
  }

  // Release 2 appeals (shyden-labs/shydesk#61): the admin's alone; for anyone else, 404.
  app.post('/desk/tickets/:id/appeal', async (c) => {
    const ticketId = c.req.param('id');
    const form = await c.req.parseBody();
    const outcome = form.outcome;
    if (outcome !== 'upheld' && outcome !== 'rejected') {
      // Said only on the admin's own appeals, so a rep still learns nothing.
      const found = c.var.staff.role === 'admin' ? await getTicket(c.env.DB, c.var.staff, ticketId) : null;
      if (found === null || (await appealPanel(c.env.DB, found.ticket)) === null) return c.notFound();
      return c.redirect(`/desk/tickets/${ticketId}?error=unknown_outcome`, 303);
    }
    try {
      const done = await decideAppeal(c.env, c.var.staff, ticketId, outcome, deps.fetcher);
      return c.redirect(`/desk/tickets/${ticketId}?appeal=${done}`, 303);
    } catch (error) {
      if (error instanceof AppealNotFound) return c.notFound();
      if (error instanceof AppealRefused) return c.redirect(`/desk/tickets/${ticketId}?error=${error.code}`, 303);
      throw error;
    }
  });

  // Legal holds (shyden-labs/shydesk#62): any rep in scope places one; the rest is the admin's, 404 for anyone else.
  const holdAction = async (c: DeskContext, ticketId: string, act: () => Promise<unknown>, done: string) => {
    try {
      await act();
      return c.redirect(`/desk/tickets/${ticketId}?hold=${done}`, 303);
    } catch (error) {
      if (error instanceof HoldNotFound) return c.notFound();
      if (error instanceof HoldRefused) return c.redirect(`/desk/tickets/${ticketId}?error=${error.reason}`, 303);
      throw error;
    }
  };
  const field = (form: Record<string, unknown>, name: string): string => {
    const value = form[name];
    return typeof value === 'string' ? value : '';
  };
  /** A form's `YYYY-MM-DD` date as midnight UTC, or undefined when missing or not a date. */
  const dateField = (form: Record<string, unknown>, name: string): number | undefined => {
    const value = field(form, name);
    const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
    return Number.isNaN(at) ? undefined : at;
  };
  const REASONS = ['crime_unreported', 'reported', 'preservation'] as const;

  app.post('/desk/tickets/:id/holds', async (c) => {
    const ticketId = c.req.param('id');
    const form = await c.req.parseBody();
    const reason = REASONS.find((r) => r === form.reason);
    const back = (error: string) => c.redirect(`/desk/tickets/${ticketId}?error=${error}`, 303);
    if (reason === undefined) return back('unknown_reason');
    const note = field(form, 'note').trim();
    if (note === '') return back('note_required');
    const attachment = field(form, 'attachment');
    const basisAt = dateField(form, 'basis');
    const input = {
      ticketId,
      reason,
      csam: form.csam === 'on',
      note,
      ...(attachment === '' ? {} : { attachmentId: attachment }),
      ...(basisAt === undefined ? {} : { basisAt }),
    };
    return holdAction(c, ticketId, () => placeHold(c.env, c.var.staff, input, Date.now()), 'placed');
  });

  app.post('/desk/tickets/:id/holds/:hold/lift', async (c) =>
    holdAction(c, c.req.param('id'), () => liftHold(c.env, c.var.staff, c.req.param('hold'), Date.now()), 'lifted'),
  );

  app.post('/desk/tickets/:id/holds/:hold/renew', async (c) => {
    const note = field(await c.req.parseBody(), 'note').trim();
    return holdAction(c, c.req.param('id'), () => renewHold(c.env, c.var.staff, c.req.param('hold'), note, Date.now()), 'renewed');
  });

  app.post('/desk/tickets/:id/holds/:hold/order', async (c) => {
    const pending = (await c.req.parseBody()).pending === '1';
    return holdAction(c, c.req.param('id'), () => setOrderPending(c.env, c.var.staff, c.req.param('hold'), pending, Date.now()), 'order');
  });

  app.post('/desk/tickets/:id/holds/:hold/no-report', async (c) => {
    const reason = field(await c.req.parseBody(), 'reason');
    return holdAction(c, c.req.param('id'), () => recordNoReport(c.env, c.var.staff, c.req.param('hold'), reason, Date.now()), 'no_report');
  });

  app.post('/desk/tickets/:id/authority-report', async (c) => {
    const ticketId = c.req.param('id');
    if (c.var.staff.role !== 'admin') return c.notFound();
    const form = await c.req.parseBody();
    const reportedAt = dateField(form, 'reported_at');
    if (reportedAt === undefined) return c.redirect(`/desk/tickets/${ticketId}?error=date_required`, 303);
    const report = { reportedTo: field(form, 'reported_to'), reportedAt, reference: field(form, 'reference') };
    return holdAction(c, ticketId, () => recordAuthorityReport(c.env, c.var.staff, ticketId, report, Date.now()), 'reported');
  });

  app.post('/desk/tickets/:id/reply', async (c) => {
    const staff = c.var.staff;
    const found = await getTicket(c.env.DB, staff, c.req.param('id'));
    if (found === null) return c.notFound();
    const { ticket } = found;
    // A bare ticket row has no customer left to answer (shyden-labs/shydesk#191).
    if (ticket.text_deleted_at !== null) return c.redirect(`/desk/tickets/${ticket.id}?error=text-deleted`, 303);
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

  // Read only (shyden-labs/shydesk#25 AC2): no route here or anywhere changes a stored file.
  app.get('/desk/files/:id', async (c) => {
    const file = await getFile(c.env.DB, c.var.staff, c.req.param('id'));
    const served = file === null ? null : await streamFile(c, c.env.FILES, file.r2_key, file.mime);
    return served ?? c.notFound();
  });

  app.get('/desk/files/:id/thumb', async (c) => {
    const file = await getFile(c.env.DB, c.var.staff, c.req.param('id'));
    const served = file === null ? null : await streamFile(c, c.env.FILES, file.thumb_key);
    return served ?? c.notFound();
  });

  app.post('/desk/tickets/:id/close', async (c) => {
    const found = await getTicket(c.env.DB, c.var.staff, c.req.param('id'));
    if (found === null) return c.notFound();
    // In scope but unchanged: a live csam hold still waits for its report to the authorities (shyden-labs/shydesk#62).
    if (!(await changeStatus(c.env, found.ticket.id, 'closed', Date.now()))) {
      return c.redirect(`/desk/tickets/${found.ticket.id}?error=authority_report_owed`, 303);
    }
    return c.redirect(`/desk/tickets/${found.ticket.id}`, 303);
  });

  return app;
}
