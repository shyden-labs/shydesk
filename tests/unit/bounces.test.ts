import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { handleBounce, type BounceMessage } from '../../src/mail/bounces.ts';
import worker from '../../src/index.ts';

// A failed delivery report sent to bounce-<notice id>@BOUNCE_DOMAIN is recorded on that notice
// (shyden-labs/shydesk#232). Anything else is rejected and nothing is written.

const ID = '0b9f1c2e-1111-4222-8333-944455556666';
const NOW = Date.UTC(2026, 10, 21, 1, 2, 3);
const DOMAIN = 'shydeskdev.dpdns.org';

const REPORT = [
  'From: MAILER-DAEMON@relay.example',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
  '',
  '--B',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; relay.example',
  '',
  'Final-Recipient: rfc822; gone@gmail.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 user unknown',
  '',
  '--B--',
  '',
].join('\r\n');

interface Run {
  sql: string;
  values: unknown[];
}

/** A D1 stand-in whose UPDATE reports `changes` rows changed. */
function database(changes: number) {
  const runs: Run[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: () => {
          runs.push({ sql, values });
          return Promise.resolve({ success: true, meta: { changes }, results: [] });
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, runs };
}

function message(to: string, raw = REPORT, rawSize = raw.length) {
  const setReject = vi.fn<(reason: string) => void>();
  const read = vi.fn(() => new Response(raw).body);
  const m = { to, from: 'MAILER-DAEMON@relay.example', rawSize, setReject } as unknown as BounceMessage;
  Object.defineProperty(m, 'raw', { get: read });
  return { m, setReject, read };
}

const UPDATE = 'UPDATE notices SET bounced_at = ?, bounce_status = ?, bounce_reason = ? WHERE id = ? AND bounced_at IS NULL';

describe('handleBounce', () => {
  it('records the status, reason and time of a failed report to bounce-<id>@domain', async () => {
    const { db, runs } = database(1);
    const { m, setReject } = message(`bounce-${ID}@${DOMAIN}`);
    await handleBounce(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, NOW);
    expect(runs).toEqual([{ sql: UPDATE, values: [NOW, '5.1.1', '550 5.1.1 user unknown', ID] }]);
    expect(setReject).not.toHaveBeenCalled();
  });

  it('matches an upper-case recipient and records it under the lower-case id', async () => {
    const { db, runs } = database(1);
    const { m, setReject } = message(`Bounce-${ID.toUpperCase()}@ShydeskDev.DPDNS.org`);
    await handleBounce(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, NOW);
    expect(runs[0]?.values.at(-1)).toBe(ID);
    expect(setReject).not.toHaveBeenCalled();
  });

  it.each([
    ['another domain', `bounce-${ID}@other.example`],
    ['a domain that only ends like the bounce domain', `bounce-${ID}@evil${DOMAIN}`],
    ['no bounce- prefix', `${ID}@${DOMAIN}`],
    ['an id that is not a UUID', `bounce-not-a-uuid-at-all-not-a-uuid-at-all@${DOMAIN}`],
    ['an id with more after it', `bounce-${ID}x@${DOMAIN}`],
  ])('rejects a recipient on %s and writes nothing', async (_what, to) => {
    const { db, runs } = database(1);
    const { m, setReject, read } = message(to);
    await handleBounce(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, NOW);
    expect(setReject).toHaveBeenCalledWith('unknown notice');
    expect(runs).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects everything when BOUNCE_DOMAIN is unset', async () => {
    const { db, runs } = database(1);
    const { m, setReject } = message(`bounce-${ID}@${DOMAIN}`);
    await handleBounce(m, { DB: db }, NOW);
    expect(setReject).toHaveBeenCalledWith('unknown notice');
    expect(runs).toEqual([]);
  });

  it('rejects a message that is not a failed delivery report and writes nothing', async () => {
    const { db, runs } = database(1);
    const { m, setReject } = message(`bounce-${ID}@${DOMAIN}`, 'Content-Type: text/plain\r\n\r\nI am away until Monday.');
    await handleBounce(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, NOW);
    expect(setReject).toHaveBeenCalledWith('not a failed delivery report');
    expect(runs).toEqual([]);
  });

  it('rejects a raw body over 1 MB unread', async () => {
    const { db, runs } = database(1);
    const { m, setReject, read } = message(`bounce-${ID}@${DOMAIN}`, REPORT, 1_000_001);
    await handleBounce(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, NOW);
    expect(setReject).toHaveBeenCalledWith('too large');
    expect(read).not.toHaveBeenCalled();
    expect(runs).toEqual([]);
  });

  it('reads a raw body of exactly 1 MB', async () => {
    const { db, runs } = database(1);
    const { m } = message(`bounce-${ID}@${DOMAIN}`, REPORT, 1_000_000);
    await handleBounce(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, NOW);
    expect(runs).toHaveLength(1);
  });

  it('rejects a report for a notice that is gone or already bounced', async () => {
    const { db } = database(0);
    const { m, setReject } = message(`bounce-${ID}@${DOMAIN}`);
    await handleBounce(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, NOW);
    expect(setReject).toHaveBeenCalledWith('unknown notice');
  });

  it('stamps the time now when none is given', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { db, runs } = database(1);
      await handleBounce(message(`bounce-${ID}@${DOMAIN}`).m, { DB: db, BOUNCE_DOMAIN: DOMAIN });
      expect(runs[0]?.values[0]).toBe(NOW);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Worker', () => {
  it('hands mail to handleBounce as its email handler, without the context in place of the time', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { db, runs } = database(1);
      const { m } = message(`bounce-${ID}@${DOMAIN}`);
      // Workers calls it with the context as a third argument.
      const email = worker.email as (...args: unknown[]) => Promise<void>;
      await email(m, { DB: db, BOUNCE_DOMAIN: DOMAIN }, { waitUntil: () => undefined });
      expect(runs[0]?.values[0]).toBe(NOW);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still answers requests', async () => {
    const response = await worker.fetch(new Request('https://x.example/health'), {});
    expect(await response.json()).toEqual({ ok: true });
  });
});
