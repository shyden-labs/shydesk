import type { Staff } from '../auth/staff.ts';
import { DAY_MS, type TimerEnv } from '../tickets/status.ts';
import { earliestRelease, type HoldReason, type HoldTiming } from './rules.ts';

/**
 * Legal holds (shyden-labs/shydesk#62; Release 2 plan Task 6): any rep in scope
 * or the admin places one on a ticket or one of its attachments; only the admin
 * lifts one, never before its earliest release. Every change writes a
 * `legal_hold_events` row, and every query is scoped to the person's products in SQL.
 */

export type HoldEnv = TimerEnv;

/** Not this person's to see or do: outside their products, already lifted, or a rep lifting. */
export class HoldNotFound extends Error {
  constructor() {
    super('hold or ticket not found');
  }
}

export type HoldRefusal = 'basis_required' | 'basis_refused' | 'not_yet';

/** A hold change the rules refuse; `earliest` is when a `not_yet` hold may first be lifted, null if not yet known. */
export class HoldRefused extends Error {
  readonly reason: HoldRefusal;
  readonly earliest: number | null | undefined;

  constructor(reason: HoldRefusal, earliest?: number | null) {
    super(reason);
    this.reason = reason;
    this.earliest = earliest;
  }
}

export interface HoldInput {
  ticketId: string;
  attachmentId?: string;
  reason: HoldReason;
  /** Suspected child-abuse material: the files are hidden from every viewer. */
  csam: boolean;
  note: string;
  /** The report date (`reported`) or the request date (`preservation`). */
  basisAt?: number;
}

const marks = (list: string[]): string => list.map(() => '?').join(', ');

/** Places a hold and its "placed" event in one batch; its id, or HoldNotFound if the ticket or attachment is not in scope. */
export async function placeHold(env: HoldEnv, staff: Staff, input: HoldInput, now: number): Promise<string> {
  if (staff.products.length === 0) throw new HoldNotFound();
  if (input.reason === 'crime_unreported') {
    if (input.basisAt !== undefined) throw new HoldRefused('basis_refused');
  } else if (input.basisAt === undefined) {
    throw new HoldRefused('basis_required');
  }
  const id = crypto.randomUUID();
  const attachmentId = input.attachmentId ?? null;
  const [placed] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO legal_holds (id, ticket_id, attachment_id, reason, csam, note, placed_by, placed_at, basis_at)
       SELECT ?, t.id, ?, ?, ?, ?, ?, ?, ? FROM tickets t WHERE t.id = ? AND t.product_id IN (${marks(staff.products)})
         AND (? IS NULL OR EXISTS (SELECT 1 FROM attachments a WHERE a.id = ? AND a.ticket_id = t.id))
       RETURNING id`,
    ).bind(
      id,
      attachmentId,
      input.reason,
      input.csam ? 1 : 0,
      input.note,
      staff.email,
      now,
      input.basisAt ?? null,
      input.ticketId,
      ...staff.products,
      attachmentId,
      attachmentId,
    ),
    // Written only if the hold was: it selects from the row just inserted.
    env.DB.prepare(
      `INSERT INTO legal_hold_events (hold_id, at, by, action, detail) SELECT id, ?, ?, ?, ? FROM legal_holds WHERE id = ?`,
    ).bind(now, staff.email, 'placed', input.note, id),
  ]);
  if (placed === undefined || placed.results.length === 0) throw new HoldNotFound();
  return id;
}

interface LiftRow extends HoldTiming {
  id: string;
  ticket_id: string;
  status: string;
  closed_at: number | null;
  attachments_keep_days: number;
  text_keep_days: number;
}

/**
 * The admin lifts a hold, refused with `not_yet` before its earliest release. A closed
 * ticket's retention timers are set again at their due dates, or now if those have passed,
 * so the lift is the decision and nothing is deleted before it.
 */
export async function liftHold(env: HoldEnv, staff: Staff, holdId: string, now: number): Promise<void> {
  if (staff.role !== 'admin' || staff.products.length === 0) throw new HoldNotFound();
  const hold = await env.DB.prepare(
    `SELECT h.id, h.ticket_id, h.reason, h.placed_at, h.basis_at, h.renewals, h.order_pending, h.no_report_reason,
            t.status, t.closed_at, p.attachments_keep_days, p.text_keep_days
     FROM legal_holds h JOIN tickets t ON t.id = h.ticket_id JOIN products p ON p.id = t.product_id
     WHERE h.id = ? AND h.lifted_at IS NULL AND t.product_id IN (${marks(staff.products)})`,
  )
    .bind(holdId, ...staff.products)
    .first<LiftRow>();
  if (hold === null) throw new HoldNotFound();
  const earliest = earliestRelease(hold);
  if (earliest === null || now < earliest) throw new HoldRefused('not_yet', earliest);
  // Two lifts at the same moment: only the one that changed the row goes on.
  const lifted = await env.DB.prepare('UPDATE legal_holds SET lifted_at = ?, lifted_by = ? WHERE id = ? AND lifted_at IS NULL RETURNING id')
    .bind(now, staff.email, holdId)
    .first();
  if (lifted === null) throw new HoldNotFound();
  await env.DB.prepare('INSERT INTO legal_hold_events (hold_id, at, by, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(holdId, now, staff.email, 'lifted', '')
    .run();
  if (hold.status !== 'closed' || hold.closed_at === null) return;
  const schedule = {
    attachments: Math.max(now, hold.closed_at + hold.attachments_keep_days * DAY_MS),
    text: Math.max(now, hold.closed_at + hold.text_keep_days * DAY_MS),
  };
  await env.TICKET_TIMER.get(env.TICKET_TIMER.idFromName(hold.ticket_id)).apply(hold.ticket_id, { schedule, cancel: [] });
}
