import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendNoReply, NOTICE_SUBJECT, type Deliver, type MailEnv } from '../../src/mail/notify.ts';
import { SmtpError, type SmtpLogin, type SmtpMail } from '../../src/mail/smtp.ts';
import type { Product } from '../../src/products.ts';
import { standInDb } from './d1-stand-in.ts';

/**
 * The no-reply notice (shyden-labs/shydesk#18 AC2 to AC4): fixed copy that
 * never carries reply text, the product's monthly share counted before any
 * socket opens, and every failure returned as `failed`, never retried.
 */

const product: Product = {
  id: 'shytalk',
  name: 'ShyTalk',
  senderAddress: 'no-reply@shytalk.app',
  ticketPageUrl: 'https://shytalk.app/support',
  allowedOrigins: ['https://shytalk.app'],
  monthlyEmailShare: 500,
  attachmentsKeepDays: 30,
  textKeepDays: 365,
  createdAt: 0,
};
const LOGINS = JSON.stringify({ 'no-reply@shytalk.app': { user: 'u', pass: 'p' } });
const LINK = 'https://shytalk.app/support#ticket=abc';
const NOW = new Date('2026-11-07T10:00:00Z');

function setup(share: { value: number } | null, logins = LOGINS) {
  const { db, statements } = standInDb((sql) => (/^INSERT INTO counters/.test(sql) && share ? [share] : []));
  const env: MailEnv = { DB: db, SMTP_LOGINS: logins };
  const sent: { login: SmtpLogin; mail: SmtpMail }[] = [];
  const deliver = vi.fn<Deliver>((login, mail) => {
    sent.push({ login, mail });
    return Promise.resolve();
  });
  return { env, statements, sent, deliver };
}

afterEach(() => vi.restoreAllMocks());

describe('sendNoReply', () => {
  it('sends the fixed notice from the product sender with its login', async () => {
    const { env, sent, deliver } = setup({ value: 1 });
    expect(await sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW)).toBe('sent');
    expect(sent).toEqual([
      {
        login: { user: 'u', pass: 'p' },
        mail: {
          from: 'no-reply@shytalk.app',
          to: 'pat@example.com',
          subject: 'Your support request: something new',
          text: `ShyTalk support\r\n\r\nThere is a new update on your support request. Open it here: ${LINK}`,
        },
      },
    ]);
    expect(NOTICE_SUBJECT).toBe('Your support request: something new');
  });

  it("counts the send against this product's month, capped at its share, in one statement", async () => {
    const { env, statements, deliver } = setup({ value: 1 });
    await sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(
      /^INSERT INTO counters .* ON CONFLICT\(key\) DO UPDATE SET value = value \+ 1 WHERE value < \? RETURNING value$/,
    );
    expect(statements[0]?.values).toEqual(['mail:shytalk:2026-11', 500]);
  });

  it('returns share-used-up and opens no connection once the share is used', async () => {
    const { env, deliver } = setup(null);
    expect(await sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW)).toBe('share-used-up');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('returns share-used-up without counting when the share is zero', async () => {
    const { env, statements, deliver } = setup({ value: 1 });
    expect(await sendNoReply(env, { ...product, monthlyEmailShare: 0 }, 'pat@example.com', LINK, deliver, NOW)).toBe('share-used-up');
    expect(statements).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('returns failed, naming the product, when its sender has no login', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env, deliver } = setup({ value: 1 }, JSON.stringify({}));
    expect(await sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW)).toBe('failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('mail for shytalk failed: no SMTP login for no-reply@shytalk.app');
  });

  it('returns failed when SMTP_LOGINS is not JSON', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env, deliver } = setup({ value: 1 }, 'not json');
    expect(await sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW)).toBe('failed');
    expect(error).toHaveBeenCalledWith('mail for shytalk failed: SMTP_LOGINS is not valid JSON');
  });

  it('returns failed naming the SMTP step on a server refusal, and delivers once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env, deliver } = setup({ value: 1 });
    deliver.mockRejectedValueOnce(new SmtpError('rcpt', '550 no such user'));
    expect(await sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW)).toBe('failed');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('mail for shytalk failed: SMTP rcpt failed: 550 no such user');
  });

  it('returns failed when the connection cannot be opened', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env, deliver } = setup({ value: 1 });
    deliver.mockRejectedValueOnce(new Error('connect timed out'));
    expect(await sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW)).toBe('failed');
    expect(error).toHaveBeenCalledWith('mail for shytalk failed: connect timed out');
  });
});
