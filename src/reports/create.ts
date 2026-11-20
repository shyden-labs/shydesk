import type { D1Database } from '@cloudflare/workers-types';
import { hashKey, reportTypeId } from '../products.ts';
import { AttachmentError, USABLE, newToken, refuseUnusable } from '../tickets/create.ts';
import { MAX_GRANT_FILES } from './grants.ts';

/**
 * A report from a product's server (shyden-labs/shydesk#59; Release 2 plan Task
 * 3). It becomes a ticket of the product's report type, open, with the subject
 * `"<reason>: <item kind> <item id>"`, and a `reports` row naming who reported
 * what. `reporter_id` is as the product's server asserts it. There is no
 * customer address, so no email is ever sent: the ticket's email is empty, and
 * its token is made and hashed only to fill the column, never handed out. The
 * note, empty or not, is the ticket's first message, which the evidence hangs on.
 */

export interface NewReport {
  reporter_id: string;
  item: { kind: string; id: string };
  subject_user_id: string;
  reason: string;
  note: string;
  context: Record<string, unknown>;
  upload_ids: string[];
}

export const MAX_ID_LENGTH = 200;
export const MAX_NOTE_LENGTH = 5000;
export const MAX_CONTEXT_LENGTH = 16_000;

/** A report the product cannot make: its reason is not one of the product's, or an upload is not its. */
export class ReportError extends Error {
  override name = 'ReportError';
  readonly code: 'unknown_reason' | 'unknown_upload';
  constructor(code: 'unknown_reason' | 'unknown_upload') {
    super(code);
    this.code = code;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ID_LENGTH;

/** The report in a request body, or null when it is not one. */
export function parseReport(body: unknown): NewReport | null {
  if (!isRecord(body) || !isRecord(body.item)) return null;
  const { reporter_id, subject_user_id, reason, note = '', context = {}, upload_ids = [] } = body;
  const { kind, id } = body.item;
  if (!isId(reporter_id) || !isId(subject_user_id) || !isId(reason) || !isId(kind) || !isId(id)) return null;
  if (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH) return null;
  if (!isRecord(context) || JSON.stringify(context).length > MAX_CONTEXT_LENGTH) return null;
  if (!Array.isArray(upload_ids) || upload_ids.length > MAX_GRANT_FILES || !upload_ids.every(isId)) return null;
  return { reporter_id, item: { kind, id }, subject_user_id, reason, note, context, upload_ids: [...new Set(upload_ids)] };
}

/** Stores the report and returns its ticket id. Throws ReportError. */
export async function createReport(db: D1Database, productId: string, r: NewReport, now = Date.now()): Promise<string> {
  const typeId = reportTypeId(productId);
  const type = await db
    .prepare('SELECT reasons_json FROM ticket_types WHERE id = ? AND product_id = ?')
    .bind(typeId, productId)
    .first<{ reasons_json: string }>();
  const reasons = type ? (JSON.parse(type.reasons_json) as string[]) : [];
  if (!reasons.includes(r.reason)) throw new ReportError('unknown_reason');
  if (r.upload_ids.length > 0) {
    try {
      await refuseUnusable(db, productId, r.upload_ids);
    } catch (error) {
      if (error instanceof AttachmentError) throw new ReportError('unknown_upload');
      throw error;
    }
  }

  const id = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const statements = [
    db.prepare(`INSERT INTO counters (key, value) VALUES ('feed_seq', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1`),
    db
      .prepare(
        `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, (SELECT value FROM counters WHERE key = 'feed_seq'))`,
      )
      .bind(id, productId, typeId, '', `${r.reason}: ${r.item.kind} ${r.item.id}`, r.reason, '{}', await hashKey(newToken()), now, now),
    db
      .prepare(
        `INSERT INTO reports (ticket_id, product_id, reporter_id, item_kind, item_id, subject_user_id, reason, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, productId, r.reporter_id, r.item.kind, r.item.id, r.subject_user_id, r.reason, JSON.stringify(r.context)),
    db
      .prepare("INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES (?, ?, 'customer', NULL, ?, ?)")
      .bind(messageId, id, r.note, now),
  ];
  if (r.upload_ids.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE attachments SET ticket_id = ?, message_id = ? WHERE id IN (${r.upload_ids.map(() => '?').join(', ')}) AND ${USABLE}`,
        )
        .bind(id, messageId, ...r.upload_ids, productId),
    );
  }
  await db.batch(statements);
  return id;
}
