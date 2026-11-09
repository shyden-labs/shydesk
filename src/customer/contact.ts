import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { hit } from '../limits.ts';
import { sendNoReply, type Deliver } from '../mail/notify.ts';
import { getTicketType, type Product, type SupportField, type TicketType } from '../products.ts';
import { AttachmentError, createTicket, ticketLink } from '../tickets/create.ts';
import { verifyTurnstile, type Fetch } from '../turnstile.ts';
import { MESSAGES } from './messages.ts';
import { requireProductOrigin } from './origin.ts';

/**
 * The contact form's API (shyden-labs/shydesk#19; plan Task 5), called by the
 * shared piece from a product's own support page:
 *
 * - `GET /support-api/config?product=<id>`: the form's settings.
 * - `POST /support-api/tickets?product=<id>`: a new ticket, checked field by
 *   field, then by Turnstile (solved on one of the product's own hosts), then
 *   by 20 per client IP and 5 per email per hour. Answers 201 with the
 *   private link and whether the notice email went; the ticket stands even
 *   when the email could not be sent, and the piece then says to keep the link.
 *   A deploy with no TURNSTILE_SECRET answers 503 and logs why.
 */

export const CATEGORIES = ['question', 'bug', 'account', 'payment', 'other'] as const;
export const MAX_ATTACHMENTS = 10;
export const MAX_VIDEO_SECONDS = 30;
const MAX_SUBJECT = 150;
const MAX_MESSAGE = 10_000;
const MAX_FIELD = 1_000;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUR = 3600;

export interface ContactBindings extends Env {
  TURNSTILE_SECRET?: string;
  TICKET_TOKEN_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  SMTP_LOGINS?: string;
}

/** What reaches outside the Worker, passed in so tests can stand it in. */
export interface ContactDeps {
  fetcher: Fetch;
  deliver: Deliver;
}

interface ContactEnv {
  Bindings: ContactBindings;
  Variables: { product: Product; clientIp: string };
}

interface Request {
  email: string;
  subject: string;
  category: string;
  message: string;
  fields: Record<string, string>;
  attachmentIds: string[];
  turnstileToken: string;
}

type Parsed = { ok: true; value: Request } | { ok: false; errors: Record<string, string> } | { ok: false; unreadable: true };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function fieldErrors(fields: SupportField[], given: Record<string, string>, errors: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const field of fields) {
    const value = (given[field.label] ?? '').trim();
    const key = `fields.${field.label}`;
    if (value === '') {
      if (field.required) errors[key] = MESSAGES.fieldRequired;
      continue;
    }
    if (value.length > MAX_FIELD) errors[key] = MESSAGES.fieldTooLong;
    else if (field.kind === 'select' && !(field.options ?? []).includes(value)) errors[key] = MESSAGES.fieldChoice;
    kept[field.label] = value;
  }
  return kept;
}

/** The request, or every field-level error at once, or that it could not be read at all. */
function parse(body: unknown, type: TicketType): Parsed {
  if (!isRecord(body)) return { ok: false, unreadable: true };
  const fields = body.fields ?? {};
  const attachmentIds = body.attachmentIds ?? [];
  if (!isRecord(fields) || Object.values(fields).some((v) => typeof v !== 'string')) return { ok: false, unreadable: true };
  if (!Array.isArray(attachmentIds) || attachmentIds.some((v) => typeof v !== 'string')) return { ok: false, unreadable: true };
  const errors: Record<string, string> = {};
  const value: Request = {
    email: text(body.email).toLowerCase(),
    subject: text(body.subject),
    category: text(body.category),
    message: text(body.message),
    fields: {},
    attachmentIds: attachmentIds as string[],
    turnstileToken: text(body.turnstileToken),
  };
  if (value.email.length > MAX_EMAIL || !EMAIL.test(value.email)) errors.email = MESSAGES.emailInvalid;
  if (value.subject === '') errors.subject = MESSAGES.subjectRequired;
  else if (value.subject.length > MAX_SUBJECT) errors.subject = MESSAGES.subjectTooLong;
  if (!(CATEGORIES as readonly string[]).includes(value.category)) errors.category = MESSAGES.categoryInvalid;
  if (value.message === '') errors.message = MESSAGES.messageRequired;
  else if (value.message.length > MAX_MESSAGE) errors.message = MESSAGES.messageTooLong;
  value.fields = fieldErrors(type.fields, fields as Record<string, string>, errors);
  if (value.attachmentIds.length > MAX_ATTACHMENTS) errors.attachmentIds = MESSAGES.tooManyAttachments;
  if (value.turnstileToken === '') errors.turnstileToken = MESSAGES.turnstile;
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** The hosts the product's pages are served on, which a Turnstile result must have been solved on. */
const productHosts = (product: Product): string[] => product.allowedOrigins.map((origin) => new URL(origin).hostname);

export function contactRoutes(deps: ContactDeps): Hono<ContactEnv> {
  const app = new Hono<ContactEnv>();
  app.use('/support-api/*', requireProductOrigin());

  app.get('/support-api/config', async (c) => {
    const product = c.var.product;
    // The notice above Send links both policies (shyden-labs/shydesk#78): without them the form is not shown.
    if (!product.privacyPolicyUrlEn || !product.privacyPolicyUrlId) {
      return c.json({ error: MESSAGES.notSetUp.replace('{product}', product.name) }, 503);
    }
    const type = await getTicketType(c.env.DB, product.id);
    return c.json({
      product: { id: product.id, name: product.name },
      types: type ? [type] : [],
      categories: CATEGORIES,
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? '',
      maxAttachments: MAX_ATTACHMENTS,
      maxVideoSeconds: MAX_VIDEO_SECONDS,
      privacy: { en: product.privacyPolicyUrlEn, id: product.privacyPolicyUrlId },
      keepDays: { attachments: product.attachmentsKeepDays, text: product.textKeepDays },
    });
  });

  app.post('/support-api/tickets', async (c) => {
    const product = c.var.product;
    const type = await getTicketType(c.env.DB, product.id);
    if (!type) return c.json({ error: MESSAGES.notFound }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: MESSAGES.badRequest }, 400);
    }
    const parsed = parse(body, type);
    if ('unreadable' in parsed) return c.json({ error: MESSAGES.badRequest }, 400);
    if (!parsed.ok) return c.json({ errors: parsed.errors }, 400);
    const request = parsed.value;

    const secret = c.env.TURNSTILE_SECRET;
    if (secret === undefined) {
      // A deploy without its Turnstile secret can check nothing: said loudly, never passed as a failed check.
      console.error('TURNSTILE_SECRET is not set: no support request can be checked');
      return c.json({ error: MESSAGES.unavailable }, 503);
    }
    const tokenKey = c.env.TICKET_TOKEN_KEY;
    if (!tokenKey) {
      console.error('TICKET_TOKEN_KEY is not set: no support request can be saved');
      return c.json({ error: MESSAGES.unavailable }, 503);
    }
    const turnstile = await verifyTurnstile(secret, request.turnstileToken, c.var.clientIp, deps.fetcher);
    if (!turnstile.ok || !(turnstile.testing || productHosts(product).includes(turnstile.hostname))) {
      return c.json({ errors: { turnstileToken: MESSAGES.turnstile } }, 400);
    }
    const now = Date.now();
    const withinIp = await hit(c.env.DB, `contact:ip:${c.var.clientIp}`, 20, HOUR, now);
    const withinEmail = await hit(c.env.DB, `contact:email:${request.email}`, 5, HOUR, now);
    if (!withinIp || !withinEmail) return c.json({ error: MESSAGES.tooMany }, 429);

    let token: string;
    try {
      ({ token } = await createTicket(c.env.DB, { productId: product.id, typeId: type.id, ...request, now, tokenKey }));
    } catch (error) {
      if (error instanceof AttachmentError) return c.json({ errors: { attachmentIds: MESSAGES.attachmentMissing } }, 400);
      throw error;
    }
    const link = ticketLink(product.ticketPageUrl, token);
    const mailed = await sendNoReply(c.env, product, request.email, link, deps.deliver, new Date(now));
    return c.json({ ticketLink: link, emailSent: mailed === 'sent' }, 201);
  });

  return app;
}
