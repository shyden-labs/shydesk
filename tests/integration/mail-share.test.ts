// The monthly email share on a real D1 database (shyden-labs/shydesk#223):
// only mail that was actually sent counts, so a failed send gives its place
// back, and two sends at once never count more than were sent.
import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import { sendNoReply, type Deliver, type MailEnv } from '../../src/mail/notify.ts';
import type { Product } from '../../src/products.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const NOW = new Date('2026-11-19T01:00:00Z');
const LINK = 'https://example.com/support#ticket=abc';
const SENDER = 'no-reply@example.com';
const env: MailEnv = { DB: db, SMTP_LOGINS: JSON.stringify({ [SENDER]: { user: 'u', pass: 'p' } }), SMTP_HOST: 'mail.example' };

const product = (id: string, share: number): Product => ({
  id,
  name: id,
  senderAddress: SENDER,
  ticketPageUrl: 'https://example.com/support',
  allowedOrigins: ['https://example.com'],
  monthlyEmailShare: share,
  attachmentsKeepDays: 30,
  textKeepDays: 365,
  createdAt: 0,
});

async function used(id: string): Promise<number | undefined> {
  const row = await db.prepare('SELECT value FROM counters WHERE key = ?').bind(`mail:${id}:2026-11`).first<{ value: number }>();
  return row?.value;
}

const sends = vi.fn<Deliver>(() => Promise.resolve());
const fails = vi.fn<Deliver>(() => Promise.reject(new Error('SMTP auth failed: 535 Incorrect authentication data')));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the monthly email share', () => {
  it('counts sent mail only: a failure gives its place back, and sends stop once the share is used', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = product('it-share-journey', 2);
    await expect(sendNoReply(env, p, 'pat@example.com', LINK, fails, NOW)).resolves.toBe('failed');
    await expect(used(p.id)).resolves.toBe(0);
    await expect(sendNoReply(env, p, 'pat@example.com', LINK, sends, NOW)).resolves.toBe('sent');
    await expect(sendNoReply(env, p, 'pat@example.com', LINK, sends, NOW)).resolves.toBe('sent');
    await expect(used(p.id)).resolves.toBe(2);
    sends.mockClear();
    await expect(sendNoReply(env, p, 'pat@example.com', LINK, sends, NOW)).resolves.toBe('share-used-up');
    expect(sends).not.toHaveBeenCalled();
    await expect(used(p.id)).resolves.toBe(2);
  });

  it('lets only one of two sends at once take the last place', async () => {
    const p = product('it-share-last-place', 1);
    const both = await Promise.all([
      sendNoReply(env, p, 'pat@example.com', LINK, sends, NOW),
      sendNoReply(env, p, 'sam@example.com', LINK, sends, NOW),
    ]);
    expect([...both].sort()).toEqual(['sent', 'share-used-up']);
    await expect(used(p.id)).resolves.toBe(1);
  });

  it('never counts more than were sent when one of two sends at once fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = product('it-share-one-fails', 2);
    const both = await Promise.all([
      sendNoReply(env, p, 'pat@example.com', LINK, sends, NOW),
      sendNoReply(env, p, 'sam@example.com', LINK, fails, NOW),
    ]);
    expect([...both].sort()).toEqual(['failed', 'sent']);
    await expect(used(p.id)).resolves.toBe(1);
  });
});
