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

/**
 * Deletes a closed ticket's text: any attachments still stored first, then its attachment rows, messages, the staff
 * read marks that reference it (shyden-labs/shydesk#119) and the ticket itself; none of the text while any hold is
 * active on the ticket.
 */
export async function deleteText(
  db: D1Database,
  files: Pick<R2Bucket, 'delete'> | undefined,
  ticketId: string,
  now: number,
): Promise<void> {
  await deleteAttachments(db, files, ticketId, now);
  await db.batch([
    db.prepare(`DELETE FROM attachments WHERE ${STILL_CLOSED} AND ${TICKET_NOT_HELD}`).bind(ticketId, ticketId),
    db.prepare(`DELETE FROM messages WHERE ${STILL_CLOSED} AND ${TICKET_NOT_HELD}`).bind(ticketId, ticketId),
    db.prepare(`DELETE FROM reads WHERE ${STILL_CLOSED} AND ${TICKET_NOT_HELD}`).bind(ticketId, ticketId),
    db.prepare(`DELETE FROM tickets WHERE id = ? AND status = 'closed' AND ${TICKET_NOT_HELD}`).bind(ticketId, ticketId),
  ]);
}
