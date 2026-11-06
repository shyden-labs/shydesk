import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { STORED_BYTES } from '../storage.ts';

/**
 * What a ticket's retention timers delete (shyden-labs/shydesk#22). Every
 * statement re-checks that the ticket is still closed, so a ticket reopened
 * after its timer fired loses nothing. Release 2 adds the legal-hold check here.
 */

const STILL_CLOSED = `ticket_id IN (SELECT id FROM tickets WHERE id = ? AND status = 'closed')`;

/** Deletes a closed ticket's stored attachments and thumbnails from R2, marks them deleted and takes their bytes off the total. */
export async function deleteAttachments(
  db: D1Database,
  files: Pick<R2Bucket, 'delete'> | undefined,
  ticketId: string,
  now: number,
): Promise<void> {
  const { results } = await db
    .prepare(`SELECT id, r2_key, thumb_key, bytes FROM attachments WHERE state = 'stored' AND ${STILL_CLOSED}`)
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

/** Deletes a closed ticket's text: any attachments still stored first, then its attachment rows, messages and the ticket itself. */
export async function deleteText(
  db: D1Database,
  files: Pick<R2Bucket, 'delete'> | undefined,
  ticketId: string,
  now: number,
): Promise<void> {
  await deleteAttachments(db, files, ticketId, now);
  await db.batch([
    db.prepare(`DELETE FROM attachments WHERE ${STILL_CLOSED}`).bind(ticketId),
    db.prepare(`DELETE FROM messages WHERE ${STILL_CLOSED}`).bind(ticketId),
    db.prepare(`DELETE FROM tickets WHERE id = ? AND status = 'closed'`).bind(ticketId),
  ]);
}
