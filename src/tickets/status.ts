import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';
import type { TicketTimer } from '../timers/ticket-timer.ts';

/**
 * Ticket status changes and the timers they set (shyden-labs/shydesk#22).
 * No job runs on a clock: each ticket has its own Durable Object timer
 * (src/timers/ticket-timer.ts), and every status change sends it a plan.
 */

export type Status = 'open' | 'waiting' | 'closed';
export type Kind = 'autoclose' | 'attachments' | 'text';

export const DAY_MS = 86_400_000;
/** Waiting on the customer this long closes the ticket by itself (design: Statuses). */
export const AUTOCLOSE_AFTER_DAYS = 7;

export interface Keep {
  attachmentsKeepDays: number;
  textKeepDays: number;
}

/** What a status change does to its ticket's timer: when each kind is due, and which kinds stop. */
export interface TimerPlan {
  schedule: Partial<Record<Kind, number>>;
  cancel: Kind[];
}

/** Closing starts retention; waiting starts auto-close; reopening stops everything. */
export function timerPlan(status: Status, keep: Keep, now: number): TimerPlan {
  switch (status) {
    case 'closed':
      return {
        schedule: { attachments: now + keep.attachmentsKeepDays * DAY_MS, text: now + keep.textKeepDays * DAY_MS },
        cancel: ['autoclose'],
      };
    case 'waiting':
      return { schedule: { autoclose: now + AUTOCLOSE_AFTER_DAYS * DAY_MS }, cancel: ['attachments', 'text'] };
    case 'open':
      return { schedule: {}, cancel: ['autoclose', 'attachments', 'text'] };
  }
}

/**
 * Moves a ticket to `to` and to the next feed seq (so the product API feed
 * returns the change), only if it is still in `onlyFrom` when given. Returns
 * its product's keep-days, or null if no ticket changed.
 */
export async function writeStatus(db: D1Database, ticketId: string, to: Status, now: number, onlyFrom?: Status): Promise<Keep | null> {
  const values: unknown[] = [to, now, to === 'closed' ? now : null, ticketId];
  if (onlyFrom !== undefined) values.push(onlyFrom);
  const [, changed] = await db.batch<{ product_id: string }>([
    db.prepare(`INSERT INTO counters (key, value) VALUES ('feed_seq', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1`),
    db
      .prepare(
        `UPDATE tickets SET status = ?, updated_at = ?, closed_at = ?, seq = (SELECT value FROM counters WHERE key = 'feed_seq')
         WHERE id = ?${onlyFrom === undefined ? '' : ' AND status = ?'} RETURNING product_id`,
      )
      .bind(...values),
  ]);
  const productId = changed?.results[0]?.product_id;
  if (productId === undefined) return null;
  const keep = await db
    .prepare('SELECT attachments_keep_days, text_keep_days FROM products WHERE id = ?')
    .bind(productId)
    .first<{ attachments_keep_days: number; text_keep_days: number }>();
  return keep === null ? null : { attachmentsKeepDays: keep.attachments_keep_days, textKeepDays: keep.text_keep_days };
}

export interface TimerEnv {
  DB: D1Database;
  TICKET_TIMER: DurableObjectNamespace<TicketTimer>;
}

/** Changes a ticket's status and sets its timer to match; false if there is no such ticket. */
export async function changeStatus(env: TimerEnv, ticketId: string, to: Status, now: number): Promise<boolean> {
  const keep = await writeStatus(env.DB, ticketId, to, now);
  if (keep === null) return false;
  await env.TICKET_TIMER.get(env.TICKET_TIMER.idFromName(ticketId)).apply(ticketId, timerPlan(to, keep, now));
  return true;
}
