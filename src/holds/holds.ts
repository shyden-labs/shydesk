import type { D1Database } from '@cloudflare/workers-types';
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

/** Not this person’s to see or do: outside their products, already lifted, or a rep making an admin-only change. */
export class HoldNotFound extends Error {
  constructor() {
    super('hold or ticket not found');
  }
}

export type HoldRefusal = 'basis_required' | 'basis_refused' | 'not_yet' | 'reason_required' | 'already_reported';

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
  // The lift and its event in one batch. Two lifts at the same moment: only the one that changed the row goes on,
  // and the event is written only for the row this lift changed.
  const [lifted] = await env.DB.batch([
    env.DB.prepare('UPDATE legal_holds SET lifted_at = ?, lifted_by = ? WHERE id = ? AND lifted_at IS NULL RETURNING id').bind(
      now,
      staff.email,
      holdId,
    ),
    env.DB.prepare(
      'INSERT INTO legal_hold_events (hold_id, at, by, action, detail) SELECT id, ?, ?, ?, ? FROM legal_holds WHERE id = ? AND lifted_at = ? AND lifted_by = ?',
    ).bind(now, staff.email, 'lifted', '', holdId, now, staff.email),
  ]);
  if (lifted === undefined || lifted.results.length === 0) throw new HoldNotFound();
  if (hold.status !== 'closed' || hold.closed_at === null) return;
  const schedule = {
    attachments: Math.max(now, hold.closed_at + hold.attachments_keep_days * DAY_MS),
    text: Math.max(now, hold.closed_at + hold.text_keep_days * DAY_MS),
  };
  await env.TICKET_TIMER.get(env.TICKET_TIMER.idFromName(hold.ticket_id)).apply(hold.ticket_id, { schedule, cancel: [] });
}

const scope = (staff: Staff): string => `ticket_id IN (SELECT id FROM tickets WHERE product_id IN (${marks(staff.products)}))`;

/** Only the admin with at least one product may make these changes; anyone else is told it is not found. */
function requireAdmin(staff: Staff): void {
  if (staff.role !== 'admin' || staff.products.length === 0) throw new HoldNotFound();
}

/**
 * One admin change to one live hold: its event first, then the change, in one batch and
 * under the same conditions, so the event exists exactly when the change does.
 */
async function changeHold(
  env: HoldEnv,
  staff: Staff,
  holdId: string,
  change: { set: string; values: unknown[]; where: string; action: string; detail: string },
  now: number,
): Promise<void> {
  const where = `WHERE id = ? AND lifted_at IS NULL AND ${change.where} AND ${scope(staff)}`;
  const [, updated] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO legal_hold_events (hold_id, at, by, action, detail) SELECT id, ?, ?, ?, ? FROM legal_holds ${where}`).bind(
      now,
      staff.email,
      change.action,
      change.detail,
      holdId,
      ...staff.products,
    ),
    env.DB.prepare(`UPDATE legal_holds SET ${change.set} ${where} RETURNING id`).bind(...change.values, holdId, ...staff.products),
  ]);
  if (updated === undefined || updated.results.length === 0) throw new HoldNotFound();
}

/** The admin renews a live preservation hold for another 90 days; `note` says why (a new request). */
export async function renewHold(env: HoldEnv, staff: Staff, holdId: string, note: string, now: number): Promise<void> {
  requireAdmin(staff);
  await changeHold(
    env,
    staff,
    holdId,
    { set: 'renewals = renewals + 1', values: [], where: "reason = 'preservation'", action: 'renewed', detail: note },
    now,
  );
}

/** The admin marks a production order pending on a live preservation hold, or answered; a pending order keeps the hold. */
export async function setOrderPending(env: HoldEnv, staff: Staff, holdId: string, pending: boolean, now: number): Promise<void> {
  requireAdmin(staff);
  await changeHold(
    env,
    staff,
    holdId,
    {
      set: 'order_pending = ?',
      values: [pending ? 1 : 0],
      where: "reason = 'preservation'",
      action: 'order',
      detail: pending ? 'pending' : 'answered',
    },
    now,
  );
}

/** The admin records why a possible crime needs no report, which lets that hold be lifted. */
export async function recordNoReport(env: HoldEnv, staff: Staff, holdId: string, reason: string, now: number): Promise<void> {
  requireAdmin(staff);
  const why = reason.trim();
  if (why === '') throw new HoldRefused('reason_required');
  await changeHold(
    env,
    staff,
    holdId,
    {
      set: 'no_report_reason = ?',
      values: [why],
      where: "reason = 'crime_unreported' AND no_report_reason IS NULL",
      action: 'no_report',
      detail: why,
    },
    now,
  );
}

export interface AuthorityReport {
  reportedTo: string;
  reportedAt: number;
  reference: string;
}

/**
 * The admin records a ticket's report to the authorities. That ticket's live
 * `crime_unreported` holds become `reported`, kept from the report's date, each with
 * a "reported" event. A ticket is reported once: a second report is refused.
 */
export async function recordAuthorityReport(
  env: HoldEnv,
  staff: Staff,
  ticketId: string,
  report: AuthorityReport,
  now: number,
): Promise<void> {
  requireAdmin(staff);
  const to = report.reportedTo.trim();
  const reference = report.reference.trim();
  if (to === '' || reference === '') throw new HoldRefused('reason_required');
  // Only holds on a ticket whose report this call wrote.
  const mine = `ticket_id = ? AND lifted_at IS NULL AND reason = 'crime_unreported' AND EXISTS (SELECT 1 FROM authority_reports r WHERE r.ticket_id = ? AND r.recorded_by = ? AND r.recorded_at = ?)`;
  const mineValues = [ticketId, ticketId, staff.email, now];
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO authority_reports (ticket_id, reported_to, reported_at, reference, recorded_by, recorded_at)
       SELECT id, ?, ?, ?, ?, ? FROM tickets WHERE id = ? AND product_id IN (${marks(staff.products)})
       ON CONFLICT DO NOTHING RETURNING ticket_id`,
    ).bind(to, report.reportedAt, reference, staff.email, now, ticketId, ...staff.products),
    env.DB.prepare(
      `INSERT INTO legal_hold_events (hold_id, at, by, action, detail) SELECT id, ?, ?, ?, ? FROM legal_holds WHERE ${mine}`,
    ).bind(now, staff.email, 'reported', `${to} ${reference}`, ...mineValues),
    env.DB.prepare(`UPDATE legal_holds SET reason = 'reported', basis_at = ? WHERE ${mine}`).bind(report.reportedAt, ...mineValues),
  ]);
  if (inserted !== undefined && inserted.results.length > 0) return;
  const already = await env.DB.prepare(
    `SELECT 1 FROM authority_reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.ticket_id = ? AND t.product_id IN (${marks(staff.products)})`,
  )
    .bind(ticketId, ...staff.products)
    .first();
  throw already === null ? new HoldNotFound() : new HoldRefused('already_reported');
}

/** A ticket owing a report to the authorities: a live csam hold and no `authority_reports` row. */
export interface LegalDuty {
  ticketId: string;
  subject: string;
  /** When its oldest live csam hold was placed. */
  placedAt: number;
}

/** A live hold whose earliest release has come, for the admin to lift or renew. */
export interface DueHold {
  holdId: string;
  ticketId: string;
  subject: string;
  earliest: number;
}

export interface LegalReview {
  duties: LegalDuty[];
  due: DueHold[];
}

interface ReviewRow extends HoldTiming {
  id: string;
  ticket_id: string;
  subject: string;
}

/**
 * The admin's legal review for the desk's list (shyden-labs/shydesk#62 AC3): tickets in
 * scope owing a report to the authorities, oldest first, and live holds past their earliest
 * release. A rep has none, and nothing is asked.
 */
export async function legalReview(db: D1Database, staff: Staff, now: number): Promise<LegalReview> {
  if (staff.role !== 'admin' || staff.products.length === 0) return { duties: [], due: [] };
  const [{ results: duties }, { results: held }] = await Promise.all([
    db
      .prepare(
        `SELECT t.id AS ticket_id, t.subject, MIN(h.placed_at) AS placed_at FROM legal_holds h JOIN tickets t ON t.id = h.ticket_id
         WHERE h.lifted_at IS NULL AND h.csam = 1 AND t.product_id IN (${marks(staff.products)})
           AND NOT EXISTS (SELECT 1 FROM authority_reports r WHERE r.ticket_id = t.id)
         GROUP BY t.id, t.subject ORDER BY placed_at, t.id`,
      )
      .bind(...staff.products)
      .all<{ ticket_id: string; subject: string; placed_at: number }>(),
    db
      .prepare(
        `SELECT h.id, h.ticket_id, t.subject, h.reason, h.placed_at, h.basis_at, h.renewals, h.order_pending, h.no_report_reason
         FROM legal_holds h JOIN tickets t ON t.id = h.ticket_id
         WHERE h.lifted_at IS NULL AND t.product_id IN (${marks(staff.products)}) ORDER BY h.placed_at, h.id`,
      )
      .bind(...staff.products)
      .all<ReviewRow>(),
  ]);
  return {
    duties: duties.map((d) => ({ ticketId: d.ticket_id, subject: d.subject, placedAt: d.placed_at })),
    due: held.flatMap((h) => {
      const earliest = earliestRelease(h);
      return earliest !== null && now >= earliest ? [{ holdId: h.id, ticketId: h.ticket_id, subject: h.subject, earliest }] : [];
    }),
  };
}
