// Legal holds on a real D1 database (shyden-labs/shydesk#62; Release 2 plan
// Task 6). One journey with every check: a rep places a hold only on a ticket in
// their products, and on an attachment only when it is that ticket's; each hold
// writes its "placed" event; the admin is refused a lift before the earliest
// release and lifts on it, with a "lifted" event, and the closed ticket's timers
// are set again. Durable Objects are not reached from here, so the timer is a
// recorder; what the timers then delete is proven in ticket-timers.test.ts.
import { describe, expect, inject, it } from 'vitest';
import type { Staff } from '../../src/auth/staff.ts';
import { HoldNotFound, HoldRefused, liftHold, placeHold, type HoldEnv } from '../../src/holds/holds.ts';
import { saveProduct, saveTicketType, supportTypeId } from '../../src/products.ts';
import { DAY_MS, type TimerPlan } from '../../src/tickets/status.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const REP: Staff = { email: 'holds-rep@example.com', role: 'rep', products: ['it-hold'] };
const ADMIN: Staff = { email: 'holds-admin@example.com', role: 'admin', products: ['it-hold', 'it-hold-other'] };
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

// Some 20 calls at about 2 s each over D1's REST API (see appeals.test.ts).
const JOURNEY_MS = 120_000;

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
    },
    JOURNEY_MS,
  );
});
