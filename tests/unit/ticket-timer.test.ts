import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { DAY_MS, timerPlan } from '../../src/tickets/status.ts';
import { TicketTimer } from '../../src/timers/ticket-timer.ts';
import { STORED_BYTES } from '../../src/storage.ts';
import { standInDb, type Answer, type Statement } from './d1-stand-in.ts';

// Each ticket's own Durable Object timer (shyden-labs/shydesk#22 AC1, AC2), on
// a stand-in storage and a fake clock: it keeps each kind's due time, sets the
// alarm to the earliest, and when it fires re-reads the ticket, so an alarm
// for a ticket reopened in between does nothing.

const NOW = Date.UTC(2026, 10, 6, 12);
const HOUR_MS = 3_600_000;
const KEEP = { attachmentsKeepDays: 30, textKeepDays: 365 };

/** Durable Object storage stand-in: values in a Map, plus the one alarm. */
function storage() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    values,
    alarm: () => alarm,
    api: {
      get: (key: string) => Promise.resolve(values.get(key)),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => Promise.resolve(values.delete(key)),
      list: ({ prefix }: { prefix: string }) =>
        Promise.resolve(new Map([...values].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)))),
      setAlarm: (at: number) => {
        alarm = at;
        return Promise.resolve();
      },
      deleteAlarm: () => {
        alarm = null;
        return Promise.resolve();
      },
    },
  };
}

type Attachment = {
  id: string;
  r2_key: string;
  thumb_key: string | null;
  bytes: number;
};

/** One ticket `t1` of product `shytalk`, in `status`, with stored attachments. */
function world(status: 'open' | 'waiting' | 'closed', attachments: Attachment[] = []) {
  const answer: Answer = (sql, values) => {
    if (sql.startsWith('UPDATE tickets')) return values[4] === status ? [{ product_id: 'shytalk' }] : [];
    if (sql.includes('FROM products')) return [{ attachments_keep_days: KEEP.attachmentsKeepDays, text_keep_days: KEEP.textKeepDays }];
    if (sql.includes('FROM attachments')) return status === 'closed' ? attachments : [];
    return [];
  };
  return standInDb(answer);
}

function timerWith(status: 'open' | 'waiting' | 'closed', attachments: Attachment[] = [], files?: unknown) {
  const store = storage();
  const { db, statements } = world(status, attachments);
  const deleted: string[][] = [];
  const bucket =
    files ??
    ({
      delete: (keys: string[]) => {
        deleted.push(keys);
        return Promise.resolve();
      },
    } as const);
  const env = files === null ? { DB: db } : { DB: db, FILES: bucket };
  const timer = new TicketTimer({ storage: store.api } as never, env as never);
  return { timer, store, statements, deleted };
}

const writes = (statements: Statement[]) => statements.filter((s) => s.method === 'run' || s.method === 'batch');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TicketTimer.apply', () => {
  it('keeps each due time and sets the alarm to the earliest', async () => {
    const { timer, store } = timerWith('closed');
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    expect(store.values.get('ticket')).toBe('t1');
    expect(store.values.get('due:attachments')).toBe(NOW + 30 * DAY_MS);
    expect(store.values.get('due:text')).toBe(NOW + 365 * DAY_MS);
    expect(store.alarm()).toBe(NOW + 30 * DAY_MS);
  });

  it('reopening cancels both, and with nothing left the alarm is removed', async () => {
    const { timer, store } = timerWith('closed');
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    await timer.apply('t1', timerPlan('open', KEEP, NOW));
    expect([...store.values.keys()]).toEqual(['ticket']);
    expect(store.alarm()).toBeNull();
  });

  it('waiting replaces retention with auto-close at +7 days', async () => {
    const { timer, store } = timerWith('waiting');
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    await timer.apply('t1', timerPlan('waiting', KEEP, NOW));
    expect(store.values.has('due:attachments')).toBe(false);
    expect(store.values.has('due:text')).toBe(false);
    expect(store.alarm()).toBe(NOW + 7 * DAY_MS);
  });
});

describe('TicketTimer.alarm', () => {
  it('auto-close closes a ticket still waiting and schedules its retention', async () => {
    const { timer, store, statements } = timerWith('waiting');
    await timer.apply('t1', timerPlan('waiting', KEEP, NOW));
    const fired = NOW + 7 * DAY_MS;
    vi.setSystemTime(fired);
    await timer.alarm();
    const update = statements.find((s) => s.sql.startsWith('UPDATE tickets'));
    expect(update?.values).toEqual(['closed', fired, fired, 't1', 'waiting']);
    expect(store.values.has('due:autoclose')).toBe(false);
    expect(store.values.get('due:attachments')).toBe(fired + 30 * DAY_MS);
    expect(store.values.get('due:text')).toBe(fired + 365 * DAY_MS);
    expect(store.alarm()).toBe(fired + 30 * DAY_MS);
  });

  it('auto-close for a ticket reopened in between does nothing', async () => {
    const { timer, store, statements } = timerWith('open');
    await timer.apply('t1', timerPlan('waiting', KEEP, NOW));
    vi.setSystemTime(NOW + 7 * DAY_MS);
    await timer.alarm();
    expect(statements.some((s) => s.sql.includes('FROM products'))).toBe(false);
    expect([...store.values.keys()]).toEqual(['ticket']);
    expect(store.alarm()).toBeNull();
  });

  it('attachments: deletes each object and thumbnail, marks the rows deleted and takes their bytes off the total', async () => {
    const { timer, store, statements, deleted } = timerWith('closed', [
      { id: 'a1', r2_key: 'k1', thumb_key: 'th1', bytes: 100 },
      { id: 'a2', r2_key: 'k2', thumb_key: null, bytes: 50 },
    ]);
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    const fired = NOW + 30 * DAY_MS;
    vi.setSystemTime(fired);
    await timer.alarm();
    expect(deleted).toEqual([['k1', 'th1', 'k2']]);
    const marked = statements.find((s) => s.sql.startsWith('UPDATE attachments'));
    expect(marked?.sql).toContain("state = 'deleted'");
    expect(marked?.values).toEqual([fired, 'a1', 'a2']);
    const total = statements.find((s) => s.sql.startsWith('UPDATE counters'));
    expect(total?.values).toEqual([150, STORED_BYTES]);
    expect(store.values.has('due:attachments')).toBe(false);
    expect(store.alarm()).toBe(NOW + 365 * DAY_MS);
  });

  it('attachments for a ticket reopened in between does nothing', async () => {
    const { timer, statements, deleted } = timerWith('open', [{ id: 'a1', r2_key: 'k1', thumb_key: null, bytes: 1 }]);
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    vi.setSystemTime(NOW + 30 * DAY_MS);
    await timer.alarm();
    expect(deleted).toEqual([]);
    expect(writes(statements)).toEqual([]);
  });

  it('attachments with nothing stored writes nothing', async () => {
    const { timer, statements, deleted } = timerWith('closed');
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    vi.setSystemTime(NOW + 30 * DAY_MS);
    await timer.alarm();
    expect(deleted).toEqual([]);
    expect(writes(statements)).toEqual([]);
  });

  // shyden-labs/shydesk#254: a dev test ticket is closed from whatever status it is in, and its text and files go at once.
  it('clear: closes the ticket from any status, then deletes its files and text straight away, leaving no timer', async () => {
    const store = storage();
    const { db, statements } = standInDb((sql) => {
      if (sql.startsWith('UPDATE tickets SET status')) return [{ product_id: 'shyden-co-uk' }];
      if (sql.includes('FROM products')) return [{ attachments_keep_days: 30, text_keep_days: 365 }];
      if (sql.includes('FROM attachments')) return [{ id: 'a1', r2_key: 'k1', thumb_key: 'k1t', bytes: 7 }];
      return [];
    });
    const deleted: string[][] = [];
    const files = { delete: (keys: string[]) => Promise.resolve(void deleted.push(keys)) };
    const timer = new TicketTimer({ storage: store.api } as never, { DB: db, FILES: files } as never);
    await timer.apply('t1', { schedule: { clear: NOW + HOUR_MS }, cancel: [] });
    expect(store.alarm()).toBe(NOW + HOUR_MS);
    const fired = NOW + HOUR_MS;
    vi.setSystemTime(fired);
    await timer.alarm();
    const close = statements.find((s) => s.sql.startsWith('UPDATE tickets SET status'));
    expect(close?.values).toEqual(['closed', fired, fired, 't1']);
    expect(deleted).toEqual([['k1', 'k1t']]);
    const deletes = statements.filter((s) => s.sql.startsWith('DELETE')).map((s) => s.sql.split(' WHERE')[0]);
    expect(deletes).toEqual([
      'DELETE FROM attachments',
      'DELETE FROM messages',
      'DELETE FROM reads',
      'DELETE FROM notices',
      'DELETE FROM tickets',
    ]);
    expect([...store.values.keys()]).toEqual(['ticket']);
    expect(store.alarm()).toBeNull();
  });

  it('text: deletes the stored attachments first, then the attachment rows, messages, staff read marks, notices and ticket, all only if still closed', async () => {
    const { timer, store, statements, deleted } = timerWith('closed', [{ id: 'a1', r2_key: 'k1', thumb_key: null, bytes: 7 }]);
    await timer.apply('t1', { schedule: { text: NOW + DAY_MS }, cancel: [] });
    vi.setSystemTime(NOW + DAY_MS);
    await timer.alarm();
    expect(deleted).toEqual([['k1']]);
    const deletes = statements.filter((s) => s.sql.startsWith('DELETE'));
    expect(deletes.map((s) => s.sql.split(' WHERE')[0])).toEqual([
      'DELETE FROM attachments',
      'DELETE FROM messages',
      'DELETE FROM reads',
      'DELETE FROM notices',
      'DELETE FROM tickets',
    ]);
    for (const d of deletes) {
      expect(d.method).toBe('batch');
      expect(d.sql).toContain("status = 'closed'");
    }
    expect(store.alarm()).toBeNull();
  });

  it('text for a ticket reopened in between does nothing', async () => {
    const { timer, statements } = timerWith('open');
    await timer.apply('t1', { schedule: { text: NOW + DAY_MS }, cancel: [] });
    vi.setSystemTime(NOW + DAY_MS);
    await timer.alarm();
    const writes = statements.filter((s) => /^(DELETE|UPDATE)/.test(s.sql));
    // Every write carries the closed check, so on an open ticket they match nothing (its read marks included,
    // shyden-labs/shydesk#119; the bare-row updates too, shyden-labs/shydesk#191; its notices, shyden-labs/shydesk#232).
    expect(writes).toHaveLength(8);
    for (const w of writes) expect(w.sql).toContain("status = 'closed'");
  });

  it('leaves a kind that is not yet due and re-arms for it', async () => {
    const { timer, store } = timerWith('closed');
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    vi.setSystemTime(NOW + 30 * DAY_MS - 1);
    await timer.alarm();
    expect(store.values.has('due:attachments')).toBe(true);
    expect(store.alarm()).toBe(NOW + 30 * DAY_MS);
  });

  it('a failure is logged naming the ticket and kind and is not retried; the overdue panel shows what was missed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = { delete: () => Promise.reject(new Error('R2 is down')) };
    const { timer, store, statements } = timerWith('closed', [{ id: 'a1', r2_key: 'k1', thumb_key: null, bytes: 1 }], failing);
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    vi.setSystemTime(NOW + 30 * DAY_MS);
    await timer.alarm();
    expect(error).toHaveBeenCalledWith('ticket t1: attachments timer failed: R2 is down');
    expect(writes(statements)).toEqual([]);
    expect(store.values.has('due:attachments')).toBe(false);
    expect(store.alarm()).toBe(NOW + 365 * DAY_MS);
  });

  it('runs timers due together in their set order, attachments before text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = { delete: () => Promise.reject(new Error('R2 is down')) };
    const { timer, store } = timerWith('closed', [{ id: 'a1', r2_key: 'k1', thumb_key: null, bytes: 1 }], failing);
    store.values.set('ticket', 't1');
    store.values.set('due:text', NOW - 1);
    store.values.set('due:attachments', NOW - 1);
    await timer.alarm();
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
      'ticket t1: attachments timer failed: R2 is down',
      'ticket t1: text timer failed: R2 is down',
    ]);
  });

  it('stored attachments with no R2 binding fail naming the story that adds it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { timer } = timerWith('closed', [{ id: 'a1', r2_key: 'k1', thumb_key: null, bytes: 1 }], null);
    await timer.apply('t1', timerPlan('closed', KEEP, NOW));
    vi.setSystemTime(NOW + 30 * DAY_MS);
    await timer.alarm();
    expect(error).toHaveBeenCalledWith(
      'ticket t1: attachments timer failed: the FILES R2 binding is missing (added with shyden-labs/shydesk#20)',
    );
  });

  it('an alarm with no ticket recorded does nothing', async () => {
    const { timer, statements } = timerWith('closed');
    await timer.alarm();
    expect(statements).toEqual([]);
  });
});
