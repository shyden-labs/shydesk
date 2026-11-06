import type { D1Database } from '@cloudflare/workers-types';
import { AUTOCLOSE_AFTER_DAYS, DAY_MS } from '../tickets/status.ts';

/**
 * What a failed timer left behind (shyden-labs/shydesk#22 AC3), worked out
 * when the admin desk loads, with no job: attachments and ticket text still
 * stored past their retention date, waiting tickets past their auto-close, and
 * uploads still pending an hour after they started (shyden-labs/shydesk#20).
 */

export type OverdueKind = 'attachment' | 'text' | 'autoclose' | 'upload';

export interface Overdue {
  kind: OverdueKind;
  id: string;
  productId: string;
  dueAt: number;
}

/** An upload not finished within this long is abandoned. */
export const UPLOAD_ABANDONED_MS = 3_600_000;

const SQL = `
SELECT 'attachment' AS kind, a.id AS id, t.product_id AS product_id, t.closed_at + p.attachments_keep_days * ${DAY_MS} AS due_at
  FROM attachments a JOIN tickets t ON t.id = a.ticket_id JOIN products p ON p.id = t.product_id
  WHERE a.state = 'stored' AND t.status = 'closed' AND t.closed_at + p.attachments_keep_days * ${DAY_MS} < ?
UNION ALL
SELECT 'text', t.id, t.product_id, t.closed_at + p.text_keep_days * ${DAY_MS}
  FROM tickets t JOIN products p ON p.id = t.product_id
  WHERE t.status = 'closed' AND t.closed_at + p.text_keep_days * ${DAY_MS} < ?
UNION ALL
SELECT 'autoclose', t.id, t.product_id, t.updated_at + ${AUTOCLOSE_AFTER_DAYS * DAY_MS}
  FROM tickets t
  WHERE t.status = 'waiting' AND t.updated_at + ${AUTOCLOSE_AFTER_DAYS * DAY_MS} < ?
UNION ALL
SELECT 'upload', a.id, a.product_id, a.created_at + ${UPLOAD_ABANDONED_MS}
  FROM attachments a
  WHERE a.state = 'pending' AND a.created_at + ${UPLOAD_ABANDONED_MS} < ?
ORDER BY due_at`;

/** Everything past its due date at `now`, oldest due first. */
export async function overdue(db: D1Database, now: number): Promise<Overdue[]> {
  const { results } = await db
    .prepare(SQL)
    .bind(now, now, now, now)
    .all<{ kind: OverdueKind; id: string; product_id: string; due_at: number }>();
  return results.map((r) => ({ kind: r.kind, id: r.id, productId: r.product_id, dueAt: r.due_at }));
}

const when = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** One line of the admin desk's overdue panel. */
export function overdueLine(o: Overdue): string {
  const at = when(o.dueAt);
  switch (o.kind) {
    case 'attachment':
      return `Attachment ${o.id} (${o.productId}) was due for deletion at ${at} and is still stored.`;
    case 'text':
      return `Ticket ${o.id} (${o.productId}) was due for text deletion at ${at} and is still stored.`;
    case 'autoclose':
      return `Ticket ${o.id} (${o.productId}) was due to close itself at ${at} and is still waiting.`;
    case 'upload':
      return `Upload ${o.id} (${o.productId}) was due to be aborted at ${at} and is still pending.`;
  }
}
