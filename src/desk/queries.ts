import type { D1Database } from '@cloudflare/workers-types';
import type { PunishmentRow } from '../db/types.ts';
import { appealTypeId } from '../appeals/appeals.ts';
import { getPunishments, reportTypeId, type PunishmentDef } from '../products.ts';
import { offenderHistory, type OffenderHistory } from '../reports/history.ts';
import type { Staff } from '../auth/staff.ts';
import type { StoredFile } from '../uploads/serve.ts';
import { NOT_WITHHELD } from '../holds/rules.ts';

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
  /** When the text timer left a bare row (shyden-labs/shydesk#191); null while the text is kept. */
  text_deleted_at: number | null;
  /** The TEST site it came from (shyden-labs/shydesk#263); null for a live ticket. */
  test_origin: string | null;
  /** 1 while the ticket's latest notice bounced (shyden-labs/shydesk#232), else 0. */
  last_notice_bounced: 0 | 1;
}

/** A notice that bounced: the reply it announced (null for a new ticket), where it went, and the server's answer. */
export interface DeskNotice {
  message_id: string | null;
  to_address: string;
  bounced_at: number;
  bounce_status: string;
  bounce_reason: string;
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
  /** 1 while a live csam hold covers it: never shown nor served (shyden-labs/shydesk#62). */
  withheld: 0 | 1;
}

export interface TicketFilter {
  status?: string | undefined;
  typeId?: string | undefined;
  cursor?: number | undefined;
}

const COLUMNS =
  'id, product_id, type_id, status, customer_email, subject, category, fields_json, created_at, updated_at, seq, token_sealed, text_deleted_at, test_origin, ' +
  'COALESCE((SELECT n.bounced_at IS NOT NULL FROM notices n WHERE n.ticket_id = tickets.id ORDER BY n.sent_at DESC, n.rowid DESC LIMIT 1), 0) AS last_notice_bounced';
const marks = (values: unknown[]): string => values.map(() => '?').join(', ');

/** Whose desk is asking: the products in scope, and whether appeals are theirs to see. */
export interface Scope {
  products: string[];
  role: Staff['role'];
}

/**
 * Appeals are the admin's alone (shyden-labs/shydesk#61): for a rep every query
 * keeps only tickets whose type is not an appeal, so not even a count reaches
 * them. A ticket of a type that is not found is left out too.
 */
const repSees = (scope: Scope, alias = ''): string =>
  scope.role === 'admin' ? '' : ` AND ${alias}type_id IN (SELECT id FROM ticket_types WHERE kind != 'appeal')`;

/** Tickets waiting on staff first, oldest first; then the rest, oldest first. */
export async function listTickets(db: D1Database, scope: Scope, filter: TicketFilter): Promise<DeskTicket[]> {
  const { products } = scope;
  if (products.length === 0) return [];
  const conditions = [`product_id IN (${marks(products)})${repSees(scope)}`];
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
  scope: Scope,
  id: string,
): Promise<{ ticket: DeskTicket; messages: DeskMessage[]; attachments: DeskAttachment[]; notices: DeskNotice[] } | null> {
  const { products } = scope;
  if (products.length === 0) return null;
  const ticket = await db
    .prepare(`SELECT ${COLUMNS} FROM tickets WHERE id = ? AND product_id IN (${marks(products)})${repSees(scope)}`)
    .bind(id, ...products)
    .first<DeskTicket>();
  if (ticket === null) return null;
  const { results: messages } = await db
    .prepare('SELECT id, author, staff_email, body, created_at FROM messages WHERE ticket_id = ? ORDER BY created_at, rowid')
    .bind(id)
    .all<DeskMessage>();
  const { results: attachments } = await db
    .prepare(
      `SELECT a.id, a.message_id, a.mime, a.bytes, a.duration_ms, a.state, CASE WHEN ${NOT_WITHHELD} THEN 0 ELSE 1 END AS withheld
       FROM attachments a WHERE a.ticket_id = ? AND a.message_id IS NOT NULL AND a.state IN ('stored', 'deleted')`,
    )
    .bind(id)
    .all<DeskAttachment>();
  const { results: notices } = await db
    .prepare(
      `SELECT message_id, to_address, bounced_at, bounce_status, bounce_reason FROM notices WHERE ticket_id = ? AND bounced_at IS NOT NULL
       ORDER BY sent_at, rowid`,
    )
    .bind(id)
    .all<DeskNotice>();
  return { ticket, messages, attachments, notices };
}

/** A stored attachment on a ticket in scope and not withheld under a csam hold, or null (shyden-labs/shydesk#25, shyden-labs/shydesk#62). */
export async function getFile(db: D1Database, scope: Scope, id: string): Promise<StoredFile | null> {
  const { products } = scope;
  if (products.length === 0) return null;
  return db
    .prepare(
      `SELECT a.r2_key, a.thumb_key, a.mime FROM attachments a JOIN tickets t ON t.id = a.ticket_id
       WHERE a.id = ? AND a.state = 'stored' AND ${NOT_WITHHELD} AND t.product_id IN (${marks(products)})${repSees(scope, 't.')}`,
    )
    .bind(id, ...products)
    .first<StoredFile>();
}

/** Tickets waiting on staff, in scope, that changed since this person last opened them. */
export async function unreadCount(db: D1Database, email: string, scope: Scope): Promise<number> {
  const { products } = scope;
  if (products.length === 0) return 0;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS unread FROM tickets t
       LEFT JOIN reads r ON r.ticket_id = t.id AND r.email = ?
       WHERE t.status = 'open' AND t.product_id IN (${marks(products)})${repSees(scope, 't.')} AND t.seq > COALESCE(r.read_seq, -1)`,
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

/** What a report ticket's page shows besides its thread (shyden-labs/shydesk#60). */
export interface ReportPanel {
  reporter_id: string;
  item_kind: string;
  item_id: string;
  subject_user_id: string;
  reason: string;
  history: OffenderHistory;
  punishments: PunishmentRow[];
  choices: PunishmentDef[];
}

/**
 * The report behind a ticket already found in scope, with the subject's history
 * in this product, this report's punishments newest first, and the product's
 * punishments to pick from; null when the ticket is not a report.
 */
export async function reportPanel(db: D1Database, ticket: DeskTicket): Promise<ReportPanel | null> {
  if (ticket.type_id !== reportTypeId(ticket.product_id)) return null;
  const report = await db
    .prepare('SELECT reporter_id, item_kind, item_id, subject_user_id, reason FROM reports WHERE ticket_id = ?')
    .bind(ticket.id)
    .first<{ reporter_id: string; item_kind: string; item_id: string; subject_user_id: string; reason: string }>();
  if (report === null) return null;
  const { results: punishments } = await db
    .prepare('SELECT * FROM punishments WHERE report_ticket_id = ? ORDER BY created_at DESC')
    .bind(ticket.id)
    .all<PunishmentRow>();
  return {
    ...report,
    history: await offenderHistory(db, ticket.product_id, report.subject_user_id, ticket.id),
    punishments,
    choices: await getPunishments(db, ticket.product_id),
  };
}

/** An appeal ticket's decision and the punishment it is about (shyden-labs/shydesk#61). */
export interface AppealPanel {
  state: string;
  decided_by: string | null;
  decided_at: number | null;
  punishment_id: string;
  label: string;
  lifted_at: number | null;
  report_ticket_id: string;
}

/** The appeal panel for an appeal ticket the admin opened; null on any other ticket. */
export async function appealPanel(db: D1Database, ticket: DeskTicket): Promise<AppealPanel | null> {
  if (ticket.type_id !== appealTypeId(ticket.product_id)) return null;
  return db
    .prepare(
      `SELECT a.state, a.decided_by, a.decided_at, p.id AS punishment_id, p.label, p.lifted_at, p.report_ticket_id
       FROM appeals a JOIN punishments p ON p.id = a.punishment_id WHERE a.ticket_id = ?`,
    )
    .bind(ticket.id)
    .first<AppealPanel>();
}
