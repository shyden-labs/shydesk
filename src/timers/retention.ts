import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { STORED_BYTES } from '../storage.ts';

/**
 * What a ticket's retention timers delete (shyden-labs/shydesk#22). Every
 * statement re-checks that the ticket is still closed, so a ticket reopened
 * after its timer fired loses nothing, and skips what is under an active legal
 * hold (shyden-labs/shydesk#62): held evidence is never deleted automatically.
 */

const STILL_CLOSED = `ticket_id IN (SELECT id FROM tickets WHERE id = ? AND status = 'closed')`;
/** No active hold covers this attachment: none on its ticket as a whole, none on the attachment itself. */
const NOT_HELD_ATTACHMENT = `NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.lifted_at IS NULL AND h.ticket_id = attachments.ticket_id AND (h.attachment_id IS NULL OR h.attachment_id = attachments.id))`;
/** No active hold of any kind is on the ticket bound to `?`. */
const TICKET_NOT_HELD = `NOT EXISTS (SELECT 1 FROM legal_holds WHERE lifted_at IS NULL AND ticket_id = ?)`;

/** Deletes a closed ticket's stored attachments and thumbnails from R2, marks them deleted and takes their bytes off the total. */
export async function deleteAttachments(
  db: D1Database,
  files: Pick<R2Bucket, 'delete'> | undefined,
  ticketId: string,
  now: number,
): Promise<void> {
  const { results } = await db
    .prepare(`SELECT id, r2_key, thumb_key, bytes FROM attachments WHERE state = 'stored' AND ${STILL_CLOSED} AND ${NOT_HELD_ATTACHMENT}`)
    .bind(ticketId)
    .all<{ id: string; r2_key: string; thumb_key: string | null; bytes: number }>();
  if (results.length === 0) return;
  if (files === undefined) throw new Error('the FILES R2 binding is missing (added with shyden-labs/shydesk#20)');
  await files.delete(results.flatMap((a) => (a.thumb_key === null ? [a.r2_key] : [a.r2_key, a.thumb_key])));
  const ids = results.map((a) => a.id);
  await db.batch([
    db.prepare(`UPDATE attachments SET state = 'deleted', deleted_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(now, ...ids),
    db.prepare('UPDATE counters SET value = value - ? WHERE key = ?').bind(
      results.reduce((sum, a) => sum + a.bytes, 0),
      STORED_BYTES,
    ),
  ]);
}

/** Attachment rows a legal hold names, kept (as deleted) for the hold's record. */
const HOLD_NAMED = 'SELECT attachment_id FROM legal_holds WHERE attachment_id IS NOT NULL';
/** Nothing else points at the ticket bound to `?`: what lets its row go rather than stay bare. */
const NOTHING_POINTS = ['reports', 'punishments', 'appeals', 'legal_holds', 'authority_reports', 'attachments']
  .map((table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${table === 'punishments' ? 'report_ticket_id' : 'ticket_id'} = ?)`)
  .join(' AND ');

/**
 * Deletes a closed ticket's text, none of it while any hold is active on the ticket: any attachments still stored
 * first, then its attachment rows, messages and the staff read marks that reference it (shyden-labs/shydesk#119).
 * Release 2 records (a report, punishments, an appeal, legal holds, an authority report) can point at the ticket, so
 * its row is blanked to a bare record (ID, product, type, status, dates) with its link killed, the report's text and
 * reporter blanked too, and the row deleted only when nothing points at it (Shyden's ruling 2026-11-17,
 * shyden-labs/shydesk#191). Attachment rows a hold names stay, as deleted, for the hold's record.
 */
export async function deleteText(
  db: D1Database,
  files: Pick<R2Bucket, 'delete'> | undefined,
  ticketId: string,
  now: number,
): Promise<void> {
  await deleteAttachments(db, files, ticketId, now);
  const whileClosed = `${STILL_CLOSED} AND ${TICKET_NOT_HELD}`;
  await db.batch([
    db.prepare(`UPDATE attachments SET message_id = NULL WHERE ${whileClosed} AND id IN (${HOLD_NAMED})`).bind(ticketId, ticketId),
    db.prepare(`DELETE FROM attachments WHERE ${whileClosed} AND id NOT IN (${HOLD_NAMED})`).bind(ticketId, ticketId),
    db.prepare(`DELETE FROM messages WHERE ${whileClosed}`).bind(ticketId, ticketId),
    db.prepare(`DELETE FROM reads WHERE ${whileClosed}`).bind(ticketId, ticketId),
    db.prepare(`UPDATE reports SET reporter_id = '', reason = '', context_json = '{}' WHERE ${whileClosed}`).bind(ticketId, ticketId),
    db
      .prepare(
        `UPDATE tickets SET customer_email = '', subject = '', category = '', fields_json = '{}', token_hash = 'deleted:' || id, token_sealed = NULL, text_deleted_at = ?
         WHERE id = ? AND status = 'closed' AND ${TICKET_NOT_HELD}`,
      )
      .bind(now, ticketId, ticketId),
    db
      .prepare(`DELETE FROM tickets WHERE id = ? AND status = 'closed' AND ${TICKET_NOT_HELD} AND ${NOTHING_POINTS}`)
      .bind(ticketId, ticketId, ...Array<string>(6).fill(ticketId)),
  ]);
}
