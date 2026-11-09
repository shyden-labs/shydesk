import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_SUBJECT, sendNoReply, type Deliver, type MailEnv } from '../../src/mail/notify.ts';
import { SmtpError } from '../../src/mail/smtp.ts';
import type { Product } from '../../src/products.ts';
import { standInDb } from './d1-stand-in.ts';

/**
 * The no-reply notice (shyden-labs/shydesk#18 AC2 to AC4). The copy is fixed
 * and never carries reply text, the product's monthly share is counted before
 * anything is delivered, and every failure is returned as `failed`, once.
 */

const LINK = 'https://shytalk.app/support#ticket=abc';
const NOW = new Date('2026-11-07T10:00:00Z');
const LOGINS = JSON.stringify({ 'no-reply@shytalk.app': { user: 'u', pass: 'p' } });

const shytalk = (share = 500): Product => ({
  id: 'shytalk',
  name: 'ShyTalk',
  senderAddress: 'no-reply@shytalk.app',
  ticketPageUrl: 'https://shytalk.app/support',
  allowedOrigins: ['https://shytalk.app'],
  monthlyEmailShare: share,
  attachmentsKeepDays: 30,
  textKeepDays: 365,
  createdAt: 0,
});

/** A database whose counter statement returns a row while the share lasts, and a delivery that records each mail. */
function world(opts: { shareLeft: boolean; logins?: string | undefined }) {
  const { db, statements } = standInDb((sql) => (sql.startsWith('INSERT INTO counters') && opts.shareLeft ? [{ value: 1 }] : []));
  const env: MailEnv = { DB: db, SMTP_LOGINS: 'logins' in opts ? opts.logins : LOGINS, SMTP_HOST: 'mail.example' };
  const deliver = vi.fn<Deliver>(() => Promise.resolve());
  return { env, statements, deliver };
}

const logged = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the notice', () => {
  it('goes from the product sender, with its login, saying only that there is something new', async () => {
    const { env, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW)).resolves.toBe('sent');
    expect(deliver.mock.calls).toEqual([
      [
        { user: 'u', pass: 'p' },
        {
          from: 'no-reply@shytalk.app',
          to: 'pat@example.com',
          subject: 'Your support request: something new',
          text: `ShyTalk support\r\n\r\nThere is a new update on your support request. Open it here: ${LINK}`,
        },
        // The Worker's mail host (shyden-labs/shydesk#68).
        'mail.example',
      ],
    ]);
    expect(NOTICE_SUBJECT).toBe('Your support request: something new');
  });
});

describe('the monthly share', () => {
  it("is counted in one capped statement on this product's month", async () => {
    const { env, statements, deliver } = world({ shareLeft: true });
    await sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW);
    expect(statements.map(({ sql, values }) => ({ sql, values }))).toEqual([
      {
        sql: 'INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 WHERE value < ? RETURNING value',
        values: ['mail:shytalk:2026-11', 500],
      },
    ]);
  });

  it('once used up, returns share-used-up and delivers nothing', async () => {
    const { env, deliver } = world({ shareLeft: false });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW)).resolves.toBe('share-used-up');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('of zero sends nothing and counts nothing', async () => {
    const { env, statements, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(0), 'pat@example.com', LINK, deliver, NOW)).resolves.toBe('share-used-up');
    expect(statements).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('a failure', () => {
  it.each([
    ['SMTP_LOGINS is not set', undefined, 'mail for shytalk failed: SMTP_LOGINS is not set'],
    ['SMTP_LOGINS is not JSON', 'not json', 'mail for shytalk failed: SMTP_LOGINS is not valid JSON'],
    ['the sender has no login', '{}', 'mail for shytalk failed: no SMTP login for no-reply@shytalk.app'],
  ])('when %s returns failed, names it, and delivers nothing', async (_case, logins, message) => {
    const error = logged();
    const { env, deliver } = world({ shareLeft: true, logins });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW)).resolves.toBe('failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([[message]]);
  });

  it.each([
    ['a refused SMTP step', new SmtpError('rcpt', '550 no such user'), 'mail for shytalk failed: SMTP rcpt failed: 550 no such user'],
    ['a connection that cannot open', new Error('connect timed out'), 'mail for shytalk failed: connect timed out'],
  ])('on %s returns failed, names it, and delivers once', async (_case, thrown, message) => {
    const error = logged();
    const { env, deliver } = world({ shareLeft: true });
    deliver.mockRejectedValueOnce(thrown);
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW)).resolves.toBe('failed');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(error.mock.calls).toEqual([[message]]);
  });
});
