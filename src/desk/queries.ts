import type { D1Database } from '@cloudflare/workers-types';
import type { Staff } from '../auth/staff.ts';

/**
 * What the staff desk reads and marks (shyden-labs/shydesk#24; plan Task 10).
 * Every read takes the products in the person's scope: a ticket outside it does
 * not exist as far as the desk can tell.
 */

export const PAGE_SIZE = 50;

export interface DeskTicket {
  id: string;
  product_id: string;
  type_id: string;
  status: string;
  customer_email: string;
  subject: string;
  category: string;
  fields_json: string;
  created_at: number;
  updated_at: number;
  seq: number;
  token_sealed: string | null;
}

export interface DeskMessage {
  id: string;
  author: string;
  staff_email: string | null;
  body: string;
  created_at: number;
}

export interface DeskAttachment {
  id: string;
  message_id: string;
  mime: string;
  bytes: number;
  duration_ms: number | null;
  state: string;
}

export interface TicketFilter {
  status?: string | undefined;
  typeId?: string | undefined;
  cursor?: number | undefined;
}

const COLUMNS =
  'id, product_id, type_id, status, customer_email, subject, category, fields_json, created_at, updated_at, seq, token_sealed';
const marks = (values: unknown[]): string => values.map(() => '?').join(', ');

/** Tickets waiting on staff first, oldest first; then the rest, oldest first. */
export async function listTickets(db: D1Database, products: string[], filter: TicketFilter): Promise<DeskTicket[]> {
  if (products.length === 0) return [];
  const conditions = [`product_id IN (${marks(products)})`];
  const values: unknown[] = [...products];
  if (filter.status !== undefined) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.typeId !== undefined) {
    conditions.push('type_id = ?');
    values.push(filter.typeId);
  }
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM tickets WHERE ${conditions.join(' AND ')}
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at, id LIMIT ? OFFSET ?`,
    )
    .bind(...values, PAGE_SIZE, filter.cursor ?? 0)
    .all<DeskTicket>();
  return results;
}

/** A ticket in scope with its thread and attachments, or null. */
export async function getTicket(
  db: D1Database,
  products: string[],
  id: string,
): Promise<{ ticket: DeskTicket; messages: DeskMessage[]; attachments: DeskAttachment[] } | null> {
  if (products.length === 0) return null;
  const ticket = await db
    .prepare(`SELECT ${COLUMNS} FROM tickets WHERE id = ? AND product_id IN (${marks(products)})`)
    .bind(id, ...products)
    .first<DeskTicket>();
  if (ticket === null) return null;
  const { results: messages } = await db
    .prepare('SELECT id, author, staff_email, body, created_at FROM messages WHERE ticket_id = ? ORDER BY created_at, rowid')
    .bind(id)
    .all<DeskMessage>();
  const { results: attachments } = await db
    .prepare(
      "SELECT id, message_id, mime, bytes, duration_ms, state FROM attachments WHERE ticket_id = ? AND message_id IS NOT NULL AND state IN ('stored', 'deleted')",
    )
    .bind(id)
    .all<DeskAttachment>();
  return { ticket, messages, attachments };
}

/** Tickets waiting on staff, in scope, that changed since this person last opened them. */
export async function unreadCount(db: D1Database, email: string, products: string[]): Promise<number> {
  if (products.length === 0) return 0;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS unread FROM tickets t
       LEFT JOIN reads r ON r.ticket_id = t.id AND r.email = ?
       WHERE t.status = 'open' AND t.product_id IN (${marks(products)}) AND t.seq > COALESCE(r.read_seq, -1)`,
    )
    .bind(email, ...products)
    .first<{ unread: number }>();
  return row?.unread ?? 0;
}

/**
 * Records that this person has seen the ticket as it is now. `reads` refers to
 * `staff`, where the first admin (named by FIRST_ADMIN_EMAIL) may have no row yet.
 */
export async function markRead(db: D1Database, staff: Staff, ticketId: string, now = Date.now()): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO reads (email, ticket_id, read_seq) VALUES (?, ?, (SELECT seq FROM tickets WHERE id = ?))
         ON CONFLICT (email, ticket_id) DO UPDATE SET read_seq = excluded.read_seq`,
      )
      .bind(staff.email, ticketId, ticketId),
  ];
  if (staff.role === 'admin') {
    statements.unshift(db.prepare("INSERT OR IGNORE INTO staff (email, role, created_at) VALUES (?, 'admin', ?)").bind(staff.email, now));
  }
  await db.batch(statements);
}

/** A canned reply's text with its placeholders filled; an unknown placeholder stays as typed. */
export function fillCanned(body: string, values: { customer_email: string; ticket_subject: string }): string {
  return body.replace(/\{\{(customer_email|ticket_subject)\}\}/g, (_match, name: 'customer_email' | 'ticket_subject') => values[name]);
}
