// Legal holds on a real D1 database (shyden-labs/shydesk#62; Release 2 plan
// Task 6). One journey with every check: a rep places a hold only on a ticket in
// their products, and on an attachment only when it is that ticket's; each hold
// writes its "placed" event; the admin is refused a lift before the earliest
// release and lifts on it, with a "lifted" event, and the closed ticket's timers
// are set again. Durable Objects are not reached from here, so the timer is a
// recorder; what the timers then delete is proven in ticket-timers.test.ts.
import { describe, expect, inject, it } from 'vitest';
import type { Staff } from '../../src/auth/staff.ts';
import {
  HoldNotFound,
  HoldRefused,
  legalReview,
  liftHold,
  placeHold,
  recordAuthorityReport,
  recordNoReport,
  renewHold,
  setOrderPending,
  ticketHolds,
  type HoldEnv,
} from '../../src/holds/holds.ts';
import { getFile } from '../../src/desk/queries.ts';
import { saveProduct, saveTicketType, supportTypeId } from '../../src/products.ts';
import { DAY_MS, writeStatus, type TimerPlan } from '../../src/tickets/status.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const REP: Staff = { email: 'holds-rep@example.com', role: 'rep', products: ['it-hold'] };
const ADMIN: Staff = { email: 'holds-admin@example.com', role: 'admin', products: ['it-hold', 'it-hold-other'] };
/** An admin of the first product only, for scope. */
const ADMIN_ONE: Staff = { email: 'holds-admin-one@example.com', role: 'admin', products: ['it-hold'] };
const T = Date.UTC(2026, 9, 1, 9);

const applied: { ticketId: string; plan: TimerPlan }[] = [];
const env = {
  DB: db,
  TICKET_TIMER: {
    idFromName: (name: string) => name,
    get: () => ({
      apply: (ticketId: string, plan: TimerPlan) => {
        applied.push({ ticketId, plan });
        return Promise.resolve();
      },
    }),
  },
} as unknown as HoldEnv;

// Some 55 calls at about 2 s each over D1's REST API (see appeals.test.ts).
const JOURNEY_MS = 240_000;

async function product(id: string): Promise<void> {
  await saveProduct(
    db,
    {
      id,
      name: `Product ${id}`,
      senderAddress: `no-reply@${id}.example`,
      ticketPageUrl: `https://${id}.example/ticket`,
      allowedOrigins: [`https://${id}.example`],
      monthlyEmailShare: 100,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    1000,
  );
  await saveTicketType(db, { productId: id, name: 'Support', fields: [] });
}

async function ticket(productId: string, id: string, closedAt: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, closed_at, seq)
       VALUES (?, ?, ?, 'closed', 'someone@example.com', 'Subject', 'bug', '{}', ?, 1000, ?, ?, 0)`,
    )
    .bind(id, productId, supportTypeId(productId), `hash-${id}`, closedAt, closedAt)
    .run();
}

async function attachment(productId: string, id: string, ticketId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attachments (id, product_id, ticket_id, r2_key, thumb_key, mime, bytes, state, created_at)
       VALUES (?, ?, ?, ?, NULL, 'image/jpeg', 10, 'stored', 1000)`,
    )
    .bind(id, productId, ticketId, `k-${id}`)
    .run();
}

const one = async (sql: string, ...values: unknown[]) =>
  db
    .prepare(sql)
    .bind(...values)
    .first();

describe('legal holds on D1', () => {
  it(
    'places holds only in scope, refuses an early lift, and lifts on the earliest release',
    async () => {
      await product('it-hold');
      await product('it-hold-other');
      await ticket('it-hold', 'it-hold-t1', T);
      await ticket('it-hold-other', 'it-hold-t2', T);
      await attachment('it-hold', 'it-hold-a1', 'it-hold-t1');
      await attachment('it-hold-other', 'it-hold-a2', 'it-hold-t2');

      // Out of scope: another product's ticket, or another ticket's attachment.
      await expect
        .soft(placeHold(env, REP, { ticketId: 'it-hold-t2', reason: 'crime_unreported', csam: false, note: 'x' }, T))
        .rejects.toBeInstanceOf(HoldNotFound);
      await expect
        .soft(
          placeHold(
            env,
            REP,
            { ticketId: 'it-hold-t1', attachmentId: 'it-hold-a2', reason: 'crime_unreported', csam: false, note: 'x' },
            T,
          ),
        )
        .rejects.toBeInstanceOf(HoldNotFound);
      expect.soft(await one(`SELECT COUNT(*) AS n FROM legal_holds WHERE ticket_id IN ('it-hold-t1', 'it-hold-t2')`)).toEqual({ n: 0 });
      expect.soft(await one(`SELECT COUNT(*) AS n FROM legal_hold_events WHERE by = ?`, REP.email)).toEqual({ n: 0 });

      // In scope: a hold on the attachment, reported to the authorities on T.
      const held = await placeHold(
        env,
        REP,
        { ticketId: 'it-hold-t1', attachmentId: 'it-hold-a1', reason: 'reported', csam: true, note: 'Image in message 1.', basisAt: T },
        T,
      );
      expect
        .soft(await one('SELECT ticket_id, attachment_id, reason, csam, basis_at, placed_by FROM legal_holds WHERE id = ?', held))
        .toEqual({
          ticket_id: 'it-hold-t1',
          attachment_id: 'it-hold-a1',
          reason: 'reported',
          csam: 1,
          basis_at: T,
          placed_by: REP.email,
        });
      expect.soft(await one('SELECT action, by, detail FROM legal_hold_events WHERE hold_id = ?', held)).toEqual({
        action: 'placed',
        by: REP.email,
        detail: 'Image in message 1.',
      });

      // A rep cannot lift; the admin cannot a day early, and can on the day.
      await expect.soft(liftHold(env, REP, held, T + 400 * DAY_MS)).rejects.toBeInstanceOf(HoldNotFound);
      await expect.soft(liftHold(env, ADMIN, held, T + 364 * DAY_MS)).rejects.toEqual(new HoldRefused('not_yet', T + 365 * DAY_MS));
      expect.soft(await one('SELECT lifted_at FROM legal_holds WHERE id = ?', held)).toEqual({ lifted_at: null });
      await liftHold(env, ADMIN, held, T + 365 * DAY_MS);
      expect.soft(await one('SELECT lifted_at, lifted_by FROM legal_holds WHERE id = ?', held)).toEqual({
        lifted_at: T + 365 * DAY_MS,
        lifted_by: ADMIN.email,
      });
      expect
        .soft(await one(`SELECT action, by FROM legal_hold_events WHERE hold_id = ? AND action = 'lifted'`, held))
        .toEqual({ action: 'lifted', by: ADMIN.email });
      expect
        .soft(applied)
        .toEqual([{ ticketId: 'it-hold-t1', plan: { schedule: { attachments: T + 365 * DAY_MS, text: T + 365 * DAY_MS }, cancel: [] } }]);

      // Lifted holds are gone from the admin's reach: a second lift is not found.
      await expect.soft(liftHold(env, ADMIN, held, T + 366 * DAY_MS)).rejects.toBeInstanceOf(HoldNotFound);

      // A preservation request: the admin renews it and marks an order pending; another product's admin and a rep cannot.
      const kept = await placeHold(
        env,
        ADMIN,
        { ticketId: 'it-hold-t2', reason: 'preservation', csam: false, note: 'Request 1', basisAt: T },
        T,
      );
      await expect.soft(renewHold(env, REP, kept, 'x', T)).rejects.toBeInstanceOf(HoldNotFound);
      await expect.soft(renewHold(env, ADMIN_ONE, kept, 'x', T)).rejects.toBeInstanceOf(HoldNotFound);
      await renewHold(env, ADMIN, kept, 'Request 2', T + DAY_MS);
      await setOrderPending(env, ADMIN, kept, true, T + 2 * DAY_MS);
      expect
        .soft(await one('SELECT renewals, order_pending FROM legal_holds WHERE id = ?', kept))
        .toEqual({ renewals: 1, order_pending: 1 });
      expect
        .soft((await db.prepare('SELECT action, by, detail FROM legal_hold_events WHERE hold_id = ? ORDER BY at').bind(kept).all()).results)
        .toEqual([
          { action: 'placed', by: ADMIN.email, detail: 'Request 1' },
          { action: 'renewed', by: ADMIN.email, detail: 'Request 2' },
          { action: 'order', by: ADMIN.email, detail: 'pending' },
        ]);
      // A pending order keeps it past its renewed term; once answered it may be lifted at T + 180 d.
      await expect.soft(liftHold(env, ADMIN, kept, T + 999 * DAY_MS)).rejects.toEqual(new HoldRefused('not_yet', null));
      await setOrderPending(env, ADMIN, kept, false, T + 3 * DAY_MS);
      await expect.soft(liftHold(env, ADMIN, kept, T + 179 * DAY_MS)).rejects.toEqual(new HoldRefused('not_yet', T + 180 * DAY_MS));
      // Only a preservation hold is renewed: a possible crime is not.
      const unreported = await placeHold(env, REP, { ticketId: 'it-hold-t1', reason: 'crime_unreported', csam: false, note: 'Threat' }, T);
      await expect.soft(renewHold(env, ADMIN, unreported, 'x', T)).rejects.toBeInstanceOf(HoldNotFound);
      // No report needed: recorded once, and the hold may then be lifted.
      await recordNoReport(env, ADMIN, unreported, 'A joke between friends.', T + DAY_MS);
      await expect.soft(recordNoReport(env, ADMIN, unreported, 'Again', T + DAY_MS)).rejects.toBeInstanceOf(HoldNotFound);
      expect
        .soft(await one('SELECT reason, no_report_reason FROM legal_holds WHERE id = ?', unreported))
        .toEqual({ reason: 'crime_unreported', no_report_reason: 'A joke between friends.' });

      // A report to the authorities on t2: refused outside the admin's products; then recorded once, turning t2's
      // unreported hold into a reported one from the report's date, and leaving t1's alone.
      const crime = await placeHold(env, ADMIN, { ticketId: 'it-hold-t2', reason: 'crime_unreported', csam: true, note: 'Image' }, T);
      const report = { reportedTo: 'Bareskrim Polri', reportedAt: T + 5 * DAY_MS, reference: 'LP/123' };
      // The admin's review on real D1: t2 owes its report; the preservation hold is due from T + 180 d, t1's no-report hold at once.
      const review = await legalReview(db, ADMIN, T + 200 * DAY_MS);
      expect.soft(review.duties.map((d) => d.ticketId)).toEqual(['it-hold-t2']);
      expect.soft(review.due.map((d) => d.holdId).sort()).toEqual([kept, unreported].sort());
      expect.soft((await legalReview(db, ADMIN_ONE, T + 200 * DAY_MS)).duties).toEqual([]);
      // Owing its report, t2 cannot close; t1's live hold is not csam, so t1 can.
      expect.soft(await writeStatus(db, 'it-hold-t2', 'closed', T + 6 * DAY_MS)).toBeNull();
      expect.soft(await writeStatus(db, 'it-hold-t1', 'closed', T + 6 * DAY_MS)).not.toBeNull();
      await expect.soft(recordAuthorityReport(env, ADMIN_ONE, 'it-hold-t2', report, T + 6 * DAY_MS)).rejects.toBeInstanceOf(HoldNotFound);
      await recordAuthorityReport(env, ADMIN, 'it-hold-t2', report, T + 6 * DAY_MS);
      await expect
        .soft(recordAuthorityReport(env, ADMIN, 'it-hold-t2', { ...report, reference: 'LP/999' }, T + 7 * DAY_MS))
        .rejects.toEqual(new HoldRefused('already_reported'));
      expect.soft((await legalReview(db, ADMIN, T + 200 * DAY_MS)).duties).toEqual([]);
      // The ticket page's holds on real D1: t2's two live holds and its report; nothing for another product's admin.
      const page = await ticketHolds(db, ADMIN, 'it-hold-t2');
      expect.soft(page.holds.map((h) => [h.id, h.reason, h.csam])).toEqual(
        [
          [kept, 'preservation', false],
          [crime, 'reported', true],
          // Both placed at T: ordered by id, as SQLite compares text.
        ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
      );
      expect
        .soft(page.report)
        .toEqual({ reportedTo: 'Bareskrim Polri', reportedAt: T + 5 * DAY_MS, reference: 'LP/123', recordedBy: ADMIN.email });
      expect.soft(await ticketHolds(db, ADMIN_ONE, 'it-hold-t2')).toEqual({ holds: [], report: null });
      // Reported, t2 closes.
      expect.soft(await writeStatus(db, 'it-hold-t2', 'closed', T + 7 * DAY_MS)).not.toBeNull();
      expect
        .soft(await one('SELECT reported_to, reported_at, reference, recorded_by FROM authority_reports WHERE ticket_id = ?', 'it-hold-t2'))
        .toEqual({
          reported_to: 'Bareskrim Polri',
          reported_at: T + 5 * DAY_MS,
          reference: 'LP/123',
          recorded_by: ADMIN.email,
        });
      expect
        .soft(await one('SELECT reason, basis_at FROM legal_holds WHERE id = ?', crime))
        .toEqual({ reason: 'reported', basis_at: T + 5 * DAY_MS });
      expect
        .soft(await one(`SELECT detail FROM legal_hold_events WHERE hold_id = ? AND action = 'reported'`, crime))
        .toEqual({ detail: 'Bareskrim Polri LP/123' });
      expect.soft(await one('SELECT reason FROM legal_holds WHERE id = ?', unreported)).toEqual({ reason: 'crime_unreported' });

      // The file lookup on real D1: t2's live csam hold withholds its file even from the admin; t1's csam hold was
      // lifted and its live hold is not csam, so t1's file is served.
      expect.soft(await getFile(db, ADMIN, 'it-hold-a2')).toBeNull();
      expect.soft(await getFile(db, ADMIN, 'it-hold-a1')).toEqual({ r2_key: 'k-it-hold-a1', thumb_key: null, mime: 'image/jpeg' });
    },
    JOURNEY_MS,
  );
});
