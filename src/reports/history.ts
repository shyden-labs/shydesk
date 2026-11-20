import type { D1Database } from '@cloudflare/workers-types';

/**
 * A report as its product reads it back, and the reported user's history
 * (shyden-labs/shydesk#59; Release 2 plan Task 3). History is per product only
 * (spec, builder call): every query filters `product_id = ?` in SQL, so another
 * product's reports and punishments never show, even for the same user id.
 */

const HISTORY_LIMIT = 50;

export interface OffenderHistory {
  reports: { ticket_id: string; reason: string; created_at: number; status: string }[];
  punishments: { id: string; label: string; created_at: number; send_state: string; lifted_at: number | null }[];
}

/** The subject's reports and punishments in this product, newest first, 50 of each, leaving out `excludeTicketId`. */
export async function offenderHistory(
  db: D1Database,
  productId: string,
  subjectUserId: string,
  excludeTicketId = '',
): Promise<OffenderHistory> {
  const { results: reports } = await db
    .prepare(
      `SELECT r.ticket_id, r.reason, t.created_at, t.status FROM reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE r.product_id = ? AND r.subject_user_id = ? AND r.ticket_id != ? ORDER BY t.created_at DESC LIMIT ${String(HISTORY_LIMIT)}`,
    )
    .bind(productId, subjectUserId, excludeTicketId)
    .all<OffenderHistory['reports'][number]>();
  const { results: punishments } = await db
    .prepare(
      `SELECT id, label, created_at, send_state, lifted_at FROM punishments WHERE product_id = ? AND subject_user_id = ? ORDER BY created_at DESC LIMIT ${String(HISTORY_LIMIT)}`,
    )
    .bind(productId, subjectUserId)
    .all<OffenderHistory['punishments'][number]>();
  return { reports, punishments };
}

export interface StoredReport {
  id: string;
  status: string;
  created_at: number;
  reporter_id: string;
  item: { kind: string; id: string };
  subject_user_id: string;
  reason: string;
  /** The note it was sent with, or null when it had none. */
  note: string | null;
  context: Record<string, unknown>;
}

interface ReportRow {
  id: string;
  status: string;
  created_at: number;
  reporter_id: string;
  item_kind: string;
  item_id: string;
  subject_user_id: string;
  reason: string;
  context_json: string;
  note: string | null;
}

/** This product's report, or null for one that does not exist or is another product's. */
export async function getReport(db: D1Database, productId: string, id: string): Promise<StoredReport | null> {
  const row = await db
    .prepare(
      `SELECT t.id, t.status, t.created_at, r.reporter_id, r.item_kind, r.item_id, r.subject_user_id, r.reason, r.context_json,
         (SELECT body FROM messages WHERE ticket_id = t.id ORDER BY created_at LIMIT 1) AS note
       FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.ticket_id = ? AND r.product_id = ?`,
    )
    .bind(id, productId)
    .first<ReportRow>();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    created_at: row.created_at,
    reporter_id: row.reporter_id,
    item: { kind: row.item_kind, id: row.item_id },
    subject_user_id: row.subject_user_id,
    reason: row.reason,
    note: row.note ? row.note : null,
    context: JSON.parse(row.context_json) as Record<string, unknown>,
  };
}
