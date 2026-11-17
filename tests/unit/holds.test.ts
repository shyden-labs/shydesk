import { describe, expect, it } from 'vitest';
import type { Staff } from '../../src/auth/staff.ts';
import { HoldNotFound, HoldRefused, liftHold, placeHold, type HoldEnv } from '../../src/holds/holds.ts';
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
