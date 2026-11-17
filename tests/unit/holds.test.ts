import { describe, expect, it } from 'vitest';
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
  type HoldEnv,
} from '../../src/holds/holds.ts';
import { DAY_MS, type TimerPlan } from '../../src/tickets/status.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// Placing and lifting legal holds (shyden-labs/shydesk#62 AC1, AC2; Release 2
// plan Task 6): any rep in scope or the admin places one; only the admin lifts
// one, never before its earliest release, and the lift reschedules the closed
// ticket's retention timers. These stand-ins check what is asked and written;
// the SQL is proven on real D1 in tests/integration/holds.test.ts.

const NOW = Date.UTC(2026, 10, 17, 12);
const T = Date.UTC(2026, 9, 1, 9);
const REP: Staff = { email: 'rep@example.com', role: 'rep', products: ['shytalk'] };
const ADMIN: Staff = { email: 'admin@example.com', role: 'admin', products: ['shytalk', 'yawelo-idle'] };

function env(answer: Answer) {
  const { db, statements } = standInDb(answer);
  const applied: { ticketId: string; plan: TimerPlan }[] = [];
  const timers = {
    idFromName: (name: string) => name,
    get: () => ({
      apply: (ticketId: string, plan: TimerPlan) => {
        applied.push({ ticketId, plan });
        return Promise.resolve();
      },
    }),
  };
  return { env: { DB: db, TICKET_TIMER: timers } as unknown as HoldEnv, statements, applied };
}

describe('placeHold', () => {
  it('a rep in scope holds a whole ticket: the hold and its "placed" event are written together, scoped to their products', async () => {
    const { env: e, statements } = env((sql) => (sql.startsWith('INSERT INTO legal_holds') ? [{ id: 'h1' }] : []));
    const id = await placeHold(e, REP, { ticketId: 't1', reason: 'crime_unreported', csam: false, note: 'Threat in message 2.' }, NOW);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statements.map((s) => s.method)).toEqual(['batch', 'batch']);
    const [insert, event] = statements;
    expect(insert?.sql).toMatch(/FROM tickets t WHERE t\.id = \? AND t\.product_id IN \(\?\)/);
    expect(insert?.values).toEqual([
      id,
      null,
      'crime_unreported',
      0,
      'Threat in message 2.',
      'rep@example.com',
      NOW,
      null,
      't1',
      'shytalk',
      null,
      null,
    ]);
    expect(event?.sql).toMatch(/INSERT INTO legal_hold_events .* SELECT .* FROM legal_holds WHERE id = \?/s);
    expect(event?.values).toEqual([NOW, 'rep@example.com', 'placed', 'Threat in message 2.', id]);
  });

  it('holds one attachment only when that attachment is on the ticket', async () => {
    const { env: e, statements } = env((sql) => (sql.startsWith('INSERT INTO legal_holds') ? [{ id: 'h1' }] : []));
    await placeHold(e, ADMIN, { ticketId: 't1', attachmentId: 'a1', reason: 'reported', csam: true, note: 'Image', basisAt: T }, NOW);
    expect(statements[0]?.sql).toMatch(
      /\(\? IS NULL OR EXISTS \(SELECT 1 FROM attachments a WHERE a\.id = \? AND a\.ticket_id = t\.id\)\)/,
    );
    expect(statements[0]?.values).toEqual([
      expect.any(String),
      'a1',
      'reported',
      1,
      'Image',
      'admin@example.com',
      NOW,
      T,
      't1',
      'shytalk',
      'yawelo-idle',
      'a1',
      'a1',
    ]);
  });

  it('a ticket or attachment outside their products is not found', async () => {
    const { env: e } = env(() => []);
    await expect(placeHold(e, REP, { ticketId: 't9', reason: 'crime_unreported', csam: false, note: 'x' }, NOW)).rejects.toBeInstanceOf(
      HoldNotFound,
    );
  });

  it('someone with no products is not found, and nothing is asked', async () => {
    const { env: e, statements } = env(() => []);
    const none: Staff = { ...REP, products: [] };
    await expect(placeHold(e, none, { ticketId: 't1', reason: 'crime_unreported', csam: false, note: 'x' }, NOW)).rejects.toBeInstanceOf(
      HoldNotFound,
    );
    expect(statements).toEqual([]);
  });

  it('a reported or preservation hold needs its basis date, and a possible crime not yet reported refuses one', async () => {
    const { env: e, statements } = env(() => []);
    for (const reason of ['reported', 'preservation'] as const) {
      await expect(placeHold(e, REP, { ticketId: 't1', reason, csam: false, note: 'x' }, NOW)).rejects.toEqual(
        new HoldRefused('basis_required'),
      );
    }
    await expect(
      placeHold(e, REP, { ticketId: 't1', reason: 'crime_unreported', csam: false, note: 'x', basisAt: T }, NOW),
    ).rejects.toEqual(new HoldRefused('basis_refused'));
    expect(statements).toEqual([]);
  });
});

const reportedHold = {
  id: 'h1',
  ticket_id: 't1',
  reason: 'reported',
  placed_at: T,
  basis_at: T,
  renewals: 0,
  order_pending: 0,
  no_report_reason: null,
  status: 'closed',
  closed_at: T,
  attachments_keep_days: 30,
  text_keep_days: 365,
};

function liftAnswer(row: Record<string, unknown>, lifted = true): Answer {
  return (sql) => {
    if (sql.startsWith('SELECT')) return [row];
    if (sql.startsWith('UPDATE legal_holds')) return lifted ? [{ id: row['id'] }] : [];
    return [];
  };
}

describe('liftHold', () => {
  it('a rep cannot lift a hold: not found, and nothing is asked', async () => {
    const { env: e, statements } = env(liftAnswer(reportedHold));
    await expect(liftHold(e, REP, 'h1', T + 400 * DAY_MS)).rejects.toBeInstanceOf(HoldNotFound);
    expect(statements).toEqual([]);
  });

  it('a hold outside the admin’s products, or already lifted, is not found', async () => {
    const { env: e, statements } = env(() => []);
    await expect(liftHold(e, ADMIN, 'h9', NOW)).rejects.toBeInstanceOf(HoldNotFound);
    expect(statements[0]?.sql).toMatch(/WHERE h\.id = \? AND h\.lifted_at IS NULL AND t\.product_id IN \(\?, \?\)/);
    expect(statements[0]?.values).toEqual(['h9', 'shytalk', 'yawelo-idle']);
  });

  it('the admin is refused one day before the earliest release, told when it is', async () => {
    const { env: e, applied } = env(liftAnswer(reportedHold));
    await expect(liftHold(e, ADMIN, 'h1', T + 364 * DAY_MS)).rejects.toEqual(new HoldRefused('not_yet', T + 365 * DAY_MS));
    expect(applied).toEqual([]);
  });

  it('a hold that cannot be lifted at all is refused with no date', async () => {
    const { env: e } = env(liftAnswer({ ...reportedHold, reason: 'crime_unreported', basis_at: null }));
    await expect(liftHold(e, ADMIN, 'h1', NOW)).rejects.toEqual(new HoldRefused('not_yet', null));
  });

  it('on the earliest release the admin lifts it, with a "lifted" event, and the closed ticket’s timers are set again', async () => {
    const at = T + 365 * DAY_MS;
    const { env: e, statements, applied } = env(liftAnswer(reportedHold));
    await liftHold(e, ADMIN, 'h1', at);
    const update = statements.find((s) => s.sql.startsWith('UPDATE legal_holds'));
    expect(update?.sql).toMatch(/SET lifted_at = \?, lifted_by = \? WHERE id = \? AND lifted_at IS NULL/);
    expect(update?.values).toEqual([at, 'admin@example.com', 'h1']);
    const event = statements.find((s) => s.sql.startsWith('INSERT INTO legal_hold_events'));
    // The lift and its event are written together; the event only for the row this lift changed.
    expect([update?.method, event?.method]).toEqual(['batch', 'batch']);
    expect(event?.sql).toMatch(/SELECT id, \?, \?, \?, \? FROM legal_holds WHERE id = \? AND lifted_at = \? AND lifted_by = \?/);
    expect(event?.values).toEqual([at, 'admin@example.com', 'lifted', '', 'h1', at, 'admin@example.com']);
    // Attachments were due at T + 30 d, long past: now. Text is due at T + 365 d: also now.
    expect(applied).toEqual([{ ticketId: 't1', plan: { schedule: { attachments: at, text: T + 365 * DAY_MS }, cancel: [] } }]);
  });

  it('a lift keeps a later due date: text due after the lift waits for it', async () => {
    const at = T + 365 * DAY_MS;
    const { env: e, applied } = env(liftAnswer({ ...reportedHold, closed_at: T + 100 * DAY_MS }));
    await liftHold(e, ADMIN, 'h1', at);
    expect(applied[0]?.plan.schedule).toEqual({ attachments: at, text: T + 465 * DAY_MS });
  });

  it('a lift keeps a later attachments due date too', async () => {
    const at = T + 365 * DAY_MS;
    const { env: e, applied } = env(liftAnswer({ ...reportedHold, closed_at: at - 10 * DAY_MS }));
    await liftHold(e, ADMIN, 'h1', at);
    expect(applied[0]?.plan.schedule).toEqual({ attachments: at + 20 * DAY_MS, text: at + 355 * DAY_MS });
  });

  it('lifting on a reopened ticket that still carries its old close date sets no timers', async () => {
    const { env: e, applied } = env(liftAnswer({ ...reportedHold, status: 'open' }));
    await liftHold(e, ADMIN, 'h1', T + 365 * DAY_MS);
    expect(applied).toEqual([]);
  });

  it('lifting on an open ticket sets no timers: closing sets them', async () => {
    const { env: e, applied } = env(liftAnswer({ ...reportedHold, status: 'open', closed_at: null }));
    await liftHold(e, ADMIN, 'h1', T + 365 * DAY_MS);
    expect(applied).toEqual([]);
  });

  it('two lifts at the same moment: only the one that changed the row goes on', async () => {
    const { env: e, statements, applied } = env(liftAnswer(reportedHold, false));
    await expect(liftHold(e, ADMIN, 'h1', T + 365 * DAY_MS)).rejects.toBeInstanceOf(HoldNotFound);
    expect(statements.filter((s) => s.method === 'batch').map((s) => s.sql.split(' ')[0])).toEqual(['UPDATE', 'INSERT']);
    expect(applied).toEqual([]);
  });
});

// Admin-only changes to a live hold (Release 2 plan Task 6). The event is written
// first and the change second, in one batch and under the same conditions, so an
// event exists exactly when the change does.
const SCOPE = /ticket_id IN \(SELECT id FROM tickets WHERE product_id IN \(\?, \?\)\)/;
const changed =
  (table: string, rows: Record<string, unknown>[]): Answer =>
  (sql) =>
    sql.startsWith(`UPDATE ${table}`) ? rows : [];

describe('renewHold', () => {
  it('a rep cannot renew: not found, and nothing is asked', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await expect(renewHold(e, REP, 'h1', 'Second request.', NOW)).rejects.toBeInstanceOf(HoldNotFound);
    expect(statements).toEqual([]);
  });

  it('the admin renews a live preservation hold in scope: a "renewed" event, then one more renewal', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await renewHold(e, ADMIN, 'h1', 'Second request.', NOW);
    expect(statements.map((s) => [s.method, s.sql.split(' ')[0]])).toEqual([
      ['batch', 'INSERT'],
      ['batch', 'UPDATE'],
    ]);
    const [event, update] = statements;
    const where = /WHERE id = \? AND lifted_at IS NULL AND reason = 'preservation' AND /;
    expect(event?.sql).toMatch(where);
    expect(event?.sql).toMatch(SCOPE);
    expect(event?.values).toEqual([NOW, 'admin@example.com', 'renewed', 'Second request.', 'h1', 'shytalk', 'yawelo-idle']);
    expect(update?.sql).toMatch(/SET renewals = renewals \+ 1 /);
    expect(update?.sql).toMatch(where);
    expect(update?.sql).toMatch(SCOPE);
    expect(update?.values).toEqual(['h1', 'shytalk', 'yawelo-idle']);
  });

  it('a hold that is not a live preservation hold in scope is not found', async () => {
    const { env: e } = env(() => []);
    await expect(renewHold(e, ADMIN, 'h9', 'x', NOW)).rejects.toBeInstanceOf(HoldNotFound);
  });
});

describe('setOrderPending', () => {
  it('a rep cannot mark an order: not found, and nothing is asked', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await expect(setOrderPending(e, REP, 'h1', true, NOW)).rejects.toBeInstanceOf(HoldNotFound);
    expect(statements).toEqual([]);
  });

  it('the admin marks a production order pending on a live preservation hold: an "order" event saying so', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await setOrderPending(e, ADMIN, 'h1', true, NOW);
    const [event, update] = statements;
    expect(event?.values).toEqual([NOW, 'admin@example.com', 'order', 'pending', 'h1', 'shytalk', 'yawelo-idle']);
    expect(update?.sql).toMatch(/SET order_pending = \? WHERE id = \? AND lifted_at IS NULL AND reason = 'preservation' AND /);
    expect(update?.sql).toMatch(SCOPE);
    expect(update?.values).toEqual([1, 'h1', 'shytalk', 'yawelo-idle']);
  });

  it('an answered order clears the mark, with an "answered" event', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await setOrderPending(e, ADMIN, 'h1', false, NOW);
    expect(statements[0]?.values[3]).toBe('answered');
    expect(statements[1]?.values[0]).toBe(0);
  });

  it('a hold that is not a live preservation hold in scope is not found', async () => {
    const { env: e } = env(() => []);
    await expect(setOrderPending(e, ADMIN, 'h9', true, NOW)).rejects.toBeInstanceOf(HoldNotFound);
  });
});

describe('recordNoReport', () => {
  it('a rep cannot record that no report is needed: not found, and nothing is asked', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await expect(recordNoReport(e, REP, 'h1', 'Not a crime.', NOW)).rejects.toBeInstanceOf(HoldNotFound);
    expect(statements).toEqual([]);
  });

  it('a blank reason is refused before anything is asked', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await expect(recordNoReport(e, ADMIN, 'h1', '   ', NOW)).rejects.toEqual(new HoldRefused('reason_required'));
    expect(statements).toEqual([]);
  });

  it('the admin records why a possible crime needs no report: a "no_report" event, then the reason on the hold', async () => {
    const { env: e, statements } = env(changed('legal_holds', [{ id: 'h1' }]));
    await recordNoReport(e, ADMIN, 'h1', ' Not a crime. ', NOW);
    const [event, update] = statements;
    const where = /WHERE id = \? AND lifted_at IS NULL AND reason = 'crime_unreported' AND no_report_reason IS NULL AND /;
    expect(event?.sql).toMatch(where);
    expect(event?.values).toEqual([NOW, 'admin@example.com', 'no_report', 'Not a crime.', 'h1', 'shytalk', 'yawelo-idle']);
    expect(update?.sql).toMatch(/SET no_report_reason = \? /);
    expect(update?.sql).toMatch(where);
    expect(update?.sql).toMatch(SCOPE);
    expect(update?.values).toEqual(['Not a crime.', 'h1', 'shytalk', 'yawelo-idle']);
  });

  it('a hold already decided, lifted or out of scope is not found', async () => {
    const { env: e } = env(() => []);
    await expect(recordNoReport(e, ADMIN, 'h9', 'x', NOW)).rejects.toBeInstanceOf(HoldNotFound);
  });
});

describe('recordAuthorityReport', () => {
  const report = { reportedTo: 'Bareskrim Polri', reportedAt: T, reference: 'LP/123' };
  const recorded: Answer = (sql) => (sql.startsWith('INSERT INTO authority_reports') ? [{ ticket_id: 't1' }] : []);

  it('a rep cannot record a report: not found, and nothing is asked', async () => {
    const { env: e, statements } = env(recorded);
    await expect(recordAuthorityReport(e, REP, 't1', report, NOW)).rejects.toBeInstanceOf(HoldNotFound);
    expect(statements).toEqual([]);
  });

  it('a blank authority or reference is refused before anything is asked', async () => {
    const { env: e, statements } = env(recorded);
    await expect(recordAuthorityReport(e, ADMIN, 't1', { ...report, reportedTo: ' ' }, NOW)).rejects.toEqual(
      new HoldRefused('reason_required'),
    );
    await expect(recordAuthorityReport(e, ADMIN, 't1', { ...report, reference: '' }, NOW)).rejects.toEqual(
      new HoldRefused('reason_required'),
    );
    expect(statements).toEqual([]);
  });

  it('the admin records the report, and that ticket’s unreported holds become reported from its date, each with an event', async () => {
    const { env: e, statements } = env(recorded);
    await recordAuthorityReport(e, ADMIN, 't1', report, NOW);
    expect(statements.map((s) => [s.method, s.sql.split(' ').slice(0, 3).join(' ')])).toEqual([
      ['batch', 'INSERT INTO authority_reports'],
      ['batch', 'INSERT INTO legal_hold_events'],
      ['batch', 'UPDATE legal_holds SET'],
    ]);
    const [insert, events, update] = statements;
    expect(insert?.sql).toMatch(/SELECT id, \?, \?, \?, \?, \? FROM tickets WHERE id = \? AND product_id IN \(\?, \?\)/);
    expect(insert?.sql).toMatch(/ON CONFLICT DO NOTHING RETURNING ticket_id/);
    expect(insert?.values).toEqual(['Bareskrim Polri', T, 'LP/123', 'admin@example.com', NOW, 't1', 'shytalk', 'yawelo-idle']);
    // Only holds on a ticket whose report this call wrote.
    const mine =
      /ticket_id = \? AND lifted_at IS NULL AND reason = 'crime_unreported' AND EXISTS \(SELECT 1 FROM authority_reports r WHERE r\.ticket_id = \? AND r\.recorded_by = \? AND r\.recorded_at = \?\)/;
    expect(events?.sql).toMatch(mine);
    expect(events?.values).toEqual([NOW, 'admin@example.com', 'reported', 'Bareskrim Polri LP/123', 't1', 't1', 'admin@example.com', NOW]);
    expect(update?.sql).toMatch(/SET reason = 'reported', basis_at = \? WHERE /);
    expect(update?.sql).toMatch(mine);
    expect(update?.values).toEqual([T, 't1', 't1', 'admin@example.com', NOW]);
  });

  it('a ticket already reported is refused, so the first report and its date stand', async () => {
    const { env: e } = env((sql) => (sql.startsWith('SELECT 1 FROM authority_reports') ? [{ 1: 1 }] : []));
    await expect(recordAuthorityReport(e, ADMIN, 't1', report, NOW)).rejects.toEqual(new HoldRefused('already_reported'));
  });

  it('a ticket outside the admin’s products is not found, and its report, if any, is not revealed', async () => {
    const { env: e, statements } = env(() => []);
    await expect(recordAuthorityReport(e, ADMIN, 't9', report, NOW)).rejects.toBeInstanceOf(HoldNotFound);
    const check = statements.find((s) => s.sql.startsWith('SELECT 1 FROM authority_reports'));
    expect(check?.sql).toMatch(/JOIN tickets t ON t\.id = r\.ticket_id WHERE r\.ticket_id = \? AND t\.product_id IN \(\?, \?\)/);
    expect(check?.values).toEqual(['t9', 'shytalk', 'yawelo-idle']);
  });
});

describe('legalReview', () => {
  const live = { reason: 'preservation', placed_at: T, basis_at: T, renewals: 0, order_pending: 0, no_report_reason: null };

  it('a rep sees no legal review, and nothing is asked', async () => {
    const { env: e, statements } = env(() => []);
    expect(await legalReview(e.DB, REP, NOW)).toEqual({ duties: [], due: [] });
    expect(statements).toEqual([]);
  });

  it('lists the tickets in scope owing a report to the authorities, oldest hold first', async () => {
    const { env: e, statements } = env((sql) =>
      sql.includes('authority_reports') ? [{ ticket_id: 't1', subject: 'Image', placed_at: T }] : [],
    );
    const review = await legalReview(e.DB, ADMIN, NOW);
    expect(review.duties).toEqual([{ ticketId: 't1', subject: 'Image', placedAt: T }]);
    const asked = statements.find((s) => s.sql.includes('authority_reports'));
    expect(asked?.sql).toMatch(/WHERE h\.lifted_at IS NULL AND h\.csam = 1 AND t\.product_id IN \(\?, \?\)/);
    expect(asked?.sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM authority_reports r WHERE r\.ticket_id = t\.id\)/);
    expect(asked?.sql).toMatch(/GROUP BY t\.id, t\.subject ORDER BY placed_at, t\.id/);
    expect(asked?.values).toEqual(['shytalk', 'yawelo-idle']);
  });

  it('lists the live holds in scope whose earliest release has come, and only those', async () => {
    const rows = [
      { ...live, id: 'h1', ticket_id: 't1', subject: 'Due today' }, // T + 90 d
      { ...live, id: 'h2', ticket_id: 't2', subject: 'Renewed', renewals: 1 }, // T + 180 d
      { ...live, id: 'h3', ticket_id: 't3', subject: 'Order', order_pending: 1 }, // never while pending
    ];
    const { env: e, statements } = env((sql) => (sql.includes('h.renewals') ? rows : []));
    const review = await legalReview(e.DB, ADMIN, T + 90 * DAY_MS);
    expect(review.due).toEqual([{ holdId: 'h1', ticketId: 't1', subject: 'Due today', earliest: T + 90 * DAY_MS }]);
    const asked = statements.find((s) => s.sql.includes('h.renewals'));
    expect(asked?.sql).toMatch(/WHERE h\.lifted_at IS NULL AND t\.product_id IN \(\?, \?\) ORDER BY h\.placed_at, h\.id/);
    expect(asked?.values).toEqual(['shytalk', 'yawelo-idle']);
  });

  it('a day before its earliest release a hold is not yet due', async () => {
    const { env: e } = env((sql) => (sql.includes('h.renewals') ? [{ ...live, id: 'h1', ticket_id: 't1', subject: 'S' }] : []));
    expect((await legalReview(e.DB, ADMIN, T + 89 * DAY_MS)).due).toEqual([]);
  });
});
