import type { R2Bucket } from '@cloudflare/workers-types';
import { Hono, type Context } from 'hono';
import type { Env } from '../env.ts';
import { hit } from '../limits.ts';
import { hashKey } from '../products.ts';
import { AttachmentError, refuseUnusable, USABLE } from '../tickets/create.ts';
import { changeStatus, type TimerEnv } from '../tickets/status.ts';
import type { Product } from '../products.ts';
import { MESSAGES } from './messages.ts';
import { requireProductOrigin } from './origin.ts';

/**
 * The customer's private ticket page (shyden-labs/shydesk#23; plan Task 9). The
 * token lives in the link's fragment and reaches ShyDesk only in an
 * `Authorization: Ticket <token>` header, so it is in no URL or server log. It
 * is looked up by its hash, for the product asked about:
 *
 * - `GET /support-api/ticket?product=<id>`: the thread, naming no staff member.
 * - `POST /support-api/ticket/reply?product=<id>`: a reply, at most 20 per client
 *   IP per hour. It always leaves the ticket open with its timers cancelled.
 * - `GET /support-api/files/:id?product=<id>` and `.../thumb`: a stored attachment
 *   of this ticket, or its preview.
 */

const MAX_MESSAGE = 10_000;
const MAX_ATTACHMENTS = 10;
const REPLIES_PER_HOUR = 20;
const HOUR = 3600;
const TOKEN = /^Ticket (\S+)$/;

interface TicketRow {
  id: string;
  subject: string;
  status: string;
  created_at: number;
}

interface MessageRow {
  id: string;
  author: string;
  body: string;
  created_at: number;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  mime: string;
  bytes: number;
  duration_ms: number | null;
  state: string;
}

interface FileRow {
  r2_key: string;
  thumb_key: string | null;
  mime: string;
}

interface Reply {
  message: string;
  attachmentIds: string[];
}

export interface TicketBindings extends Env, TimerEnv {
  FILES: R2Bucket;
}

export interface TicketEnv {
  Bindings: TicketBindings;
  Variables: { product: Product; clientIp: string };
}

type TicketContext = Context<TicketEnv>;

/** The ticket this request's token opens for the product asked about, or null. */
async function openTicket(c: TicketContext): Promise<TicketRow | null> {
  const token = TOKEN.exec(c.req.header('Authorization') ?? '')?.[1];
  if (token === undefined) return null;
  return c.env.DB.prepare('SELECT id, subject, status, created_at FROM tickets WHERE token_hash = ? AND product_id = ?')
    .bind(await hashKey(token), c.var.product.id)
    .first<TicketRow>();
}

/** A reply's fields, or the message saying what is wrong with them. */
function readReply(body: unknown): Reply | { problem: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { problem: MESSAGES.badRequest };
  const { message, attachmentIds = [] } = body as { message?: unknown; attachmentIds?: unknown };
  if (typeof message !== 'string' || message.trim() === '') return { problem: MESSAGES.messageRequired };
  if (message.length > MAX_MESSAGE) return { problem: MESSAGES.messageTooLong };
  if (!Array.isArray(attachmentIds) || !attachmentIds.every((id) => typeof id === 'string')) return { problem: MESSAGES.badRequest };
  if (attachmentIds.length > MAX_ATTACHMENTS) return { problem: MESSAGES.tooManyAttachments };
  return { message, attachmentIds: [...new Set<string>(attachmentIds)] };
}

async function saveReply(c: TicketContext, ticketId: string, reply: Reply, now: number): Promise<void> {
  const db = c.env.DB;
  const messageId = crypto.randomUUID();
  const statements = [
    db
      .prepare("INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES (?, ?, 'customer', NULL, ?, ?)")
      .bind(messageId, ticketId, reply.message, now),
  ];
  if (reply.attachmentIds.length > 0) {
    const marks = reply.attachmentIds.map(() => '?').join(', ');
    statements.push(
      db
        .prepare(`UPDATE attachments SET ticket_id = ?, message_id = ? WHERE id IN (${marks}) AND ${USABLE}`)
        .bind(ticketId, messageId, ...reply.attachmentIds, c.var.product.id),
    );
  }
  await db.batch(statements);
}

/** Streams the object at `key`, private to this page and never sniffed; 404 if it has gone. */
async function streamFile(c: TicketContext, key: string | null, mime?: string): Promise<Response> {
  const object = key === null ? null : await c.env.FILES.get(key);
  if (object === null) return c.json({ error: MESSAGES.notFound }, 404);
  // A preview is a JPEG or a WebP: the type it was stored with says which.
  const type = mime ?? object.httpMetadata?.contentType ?? 'image/jpeg';
  // Through the context, so the origin check's CORS headers stay on the answer.
  return c.body(object.body as unknown as ReadableStream, 200, {
    'Content-Type': type,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}

/** The attachment `:id` when it is stored on the token's own ticket, or null. */
async function fileOfTicket(c: TicketContext, id: string): Promise<FileRow | null> {
  const ticket = await openTicket(c);
  if (ticket === null) return null;
  return c.env.DB.prepare("SELECT r2_key, thumb_key, mime FROM attachments WHERE id = ? AND ticket_id = ? AND state = 'stored'")
    .bind(id, ticket.id)
    .first<FileRow>();
}

export function ticketRoutes(): Hono<TicketEnv> {
  const routes = new Hono<TicketEnv>();
  routes.use('/support-api/ticket', requireProductOrigin());
  routes.use('/support-api/ticket/*', requireProductOrigin());
  routes.use('/support-api/files/*', requireProductOrigin());

  routes.get('/support-api/ticket', async (c) => {
    const ticket = await openTicket(c);
    if (ticket === null) return c.json({ error: MESSAGES.linkInvalid }, 404);
    const { results: messages } = await c.env.DB.prepare(
      'SELECT id, author, body, created_at FROM messages WHERE ticket_id = ? ORDER BY created_at, rowid',
    )
      .bind(ticket.id)
      .all<MessageRow>();
    const { results: attachments } = await c.env.DB.prepare(
      "SELECT id, message_id, mime, bytes, duration_ms, state FROM attachments WHERE ticket_id = ? AND message_id IS NOT NULL AND state IN ('stored', 'deleted')",
    )
      .bind(ticket.id)
      .all<AttachmentRow>();
    return c.json({
      ticket: { subject: ticket.subject, status: ticket.status, createdAt: ticket.created_at },
      messages: messages.map((message) => ({
        author: message.author,
        body: message.body,
        createdAt: message.created_at,
        attachments: attachments
          .filter((attachment) => attachment.message_id === message.id)
          .map((attachment) => ({
            id: attachment.id,
            mime: attachment.mime,
            bytes: attachment.bytes,
            durationMs: attachment.duration_ms,
            removed: attachment.state === 'deleted',
          })),
      })),
    });
  });

  routes.post('/support-api/ticket/reply', async (c) => {
    const ticket = await openTicket(c);
    if (ticket === null) return c.json({ error: MESSAGES.linkInvalid }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: MESSAGES.badRequest }, 400);
    }
    const reply = readReply(body);
    if ('problem' in reply) return c.json({ error: reply.problem }, 400);
    const now = Date.now();
    if (!(await hit(c.env.DB, `reply:ip:${c.var.clientIp}`, REPLIES_PER_HOUR, HOUR, now))) return c.json({ error: MESSAGES.tooMany }, 429);
    try {
      if (reply.attachmentIds.length > 0) await refuseUnusable(c.env.DB, c.var.product.id, reply.attachmentIds);
    } catch (error) {
      if (error instanceof AttachmentError) return c.json({ error: MESSAGES.attachmentMissing }, 400);
      throw error;
    }
    await saveReply(c, ticket.id, reply, now);
    await changeStatus(c.env, ticket.id, 'open', now);
    return c.body(null, 201);
  });

  routes.get('/support-api/files/:id', async (c) => {
    const file = await fileOfTicket(c, c.req.param('id'));
    if (file === null) return c.json({ error: MESSAGES.notFound }, 404);
    return streamFile(c, file.r2_key, file.mime);
  });

  routes.get('/support-api/files/:id/thumb', async (c) => {
    const file = await fileOfTicket(c, c.req.param('id'));
    if (file === null) return c.json({ error: MESSAGES.notFound }, 404);
    return streamFile(c, file.thumb_key);
  });

  return routes;
}
