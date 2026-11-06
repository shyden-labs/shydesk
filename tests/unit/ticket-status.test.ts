import { describe, it, expect } from 'vitest';
import { DAY_MS, changeStatus, timerPlan, writeStatus, type TimerPlan } from '../../src/tickets/status.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// Ticket status changes and the timers they set (shyden-labs/shydesk#22 AC1):
// closing schedules attachments at +attachments_keep_days and text at
// +text_keep_days; reopening cancels both; waiting schedules auto-close at +7 days.

const NOW = Date.UTC(2026, 10, 6, 12);
const KEEP = { attachmentsKeepDays: 30, textKeepDays: 365 };

describe('timerPlan', () => {
  it('closing schedules attachments at +30 days and text at +365 days, and cancels auto-close', () => {
    expect(timerPlan('closed', KEEP, NOW)).toEqual({
      schedule: { attachments: NOW + 30 * DAY_MS, text: NOW + 365 * DAY_MS },
      cancel: ['autoclose'],
    });
  });

  it("closing uses the product's own keep-days", () => {
    expect(timerPlan('closed', { attachmentsKeepDays: 2, textKeepDays: 3 }, NOW).schedule).toEqual({
      attachments: NOW + 2 * DAY_MS,
      text: NOW + 3 * DAY_MS,
    });
  });

  it('waiting schedules auto-close at +7 days and cancels retention', () => {
    expect(timerPlan('waiting', KEEP, NOW)).toEqual({ schedule: { autoclose: NOW + 7 * DAY_MS }, cancel: ['attachments', 'text'] });
  });

  it('reopening cancels every timer', () => {
    expect(timerPlan('open', KEEP, NOW)).toEqual({ schedule: {}, cancel: ['autoclose', 'attachments', 'text'] });
  });

  it('a day is 86,400,000 ms', () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});

/** A D1 stand-in holding one ticket of product `shytalk`; the UPDATE returns it only when its conditions match. */
function ticketDb(status: string | null) {
  const answer: Answer = (sql, values) => {
    if (sql.startsWith('UPDATE tickets')) {
      const id = values[3];
      const from = values[4];
      return status !== null && id === 't1' && (from === undefined || from === status) ? [{ product_id: 'shytalk' }] : [];
    }
    if (sql.includes('FROM products')) return values[0] === 'shytalk' ? [{ attachments_keep_days: 30, text_keep_days: 365 }] : [];
    return [];
  };
  return standInDb(answer);
}

describe('writeStatus', () => {
  it('bumps feed_seq and moves the ticket to it, with its status, updated_at and closed_at, in one batch', async () => {
    const { db, statements } = ticketDb('open');
    expect(await writeStatus(db, 't1', 'closed', NOW)).toEqual(KEEP);
    const batch = statements.filter((s) => s.method === 'batch');
    expect(batch).toHaveLength(2);
    expect(batch[0]?.sql).toContain("'feed_seq'");
    expect(batch[0]?.sql).toContain('value = value + 1');
    expect(batch[1]?.sql).toContain("seq = (SELECT value FROM counters WHERE key = 'feed_seq')");
    expect(batch[1]?.values).toEqual(['closed', NOW, NOW, 't1']);
  });

  it('clears closed_at when the ticket is not closed', async () => {
    const { db, statements } = ticketDb('closed');
    await writeStatus(db, 't1', 'open', NOW);
    expect(statements.find((s) => s.sql.startsWith('UPDATE tickets'))?.values).toEqual(['open', NOW, null, 't1']);
  });

  it('only changes a ticket still in the expected status', async () => {
    const { db, statements } = ticketDb('open');
    expect(await writeStatus(db, 't1', 'closed', NOW, 'waiting')).toBeNull();
    const update = statements.find((s) => s.sql.startsWith('UPDATE tickets'));
    expect(update?.sql).toContain('AND status = ?');
    expect(update?.values).toEqual(['closed', NOW, NOW, 't1', 'waiting']);
    expect(statements.some((s) => s.sql.includes('FROM products'))).toBe(false);
  });

  it('returns null for an unknown ticket', async () => {
    expect(await writeStatus(ticketDb(null).db, 't1', 'closed', NOW)).toBeNull();
  });

  it('returns null when the ticket names a product that no longer exists', async () => {
    const { db } = standInDb((sql) => (sql.startsWith('UPDATE tickets') ? [{ product_id: 'gone' }] : []));
    expect(await writeStatus(db, 't1', 'closed', NOW)).toBeNull();
  });
});

/** A TICKET_TIMER stand-in: records which object each plan was sent to. */
function timers() {
  const sent: { name: string; ticketId: string; plan: TimerPlan }[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      apply: (ticketId: string, plan: TimerPlan) => {
        sent.push({ name: id.name, ticketId, plan });
        return Promise.resolve();
      },
    }),
  };
  return { namespace, sent };
}

describe('changeStatus', () => {
  it("closing writes the ticket and sends the close plan to that ticket's own timer", async () => {
    const { db } = ticketDb('open');
    const { namespace, sent } = timers();
    expect(await changeStatus({ DB: db, TICKET_TIMER: namespace as never }, 't1', 'closed', NOW)).toBe(true);
    expect(sent).toEqual([{ name: 't1', ticketId: 't1', plan: timerPlan('closed', KEEP, NOW) }]);
  });

  it('reopening sends a plan that cancels both retention timers', async () => {
    const { db } = ticketDb('closed');
    const { namespace, sent } = timers();
    await changeStatus({ DB: db, TICKET_TIMER: namespace as never }, 't1', 'open', NOW);
    expect(sent[0]?.plan.cancel).toEqual(expect.arrayContaining(['attachments', 'text']));
  });

  it('waiting sends the auto-close plan', async () => {
    const { db } = ticketDb('open');
    const { namespace, sent } = timers();
    await changeStatus({ DB: db, TICKET_TIMER: namespace as never }, 't1', 'waiting', NOW);
    expect(sent[0]?.plan.schedule).toEqual({ autoclose: NOW + 7 * DAY_MS });
  });

  it('an unknown ticket returns false and sets no timer', async () => {
    const { namespace, sent } = timers();
    expect(await changeStatus({ DB: ticketDb(null).db, TICKET_TIMER: namespace as never }, 't1', 'closed', NOW)).toBe(false);
    expect(sent).toEqual([]);
  });
});
