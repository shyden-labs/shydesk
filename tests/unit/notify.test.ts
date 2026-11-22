import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_SUBJECT, sendNoReply, type Deliver, type MailEnv } from '../../src/mail/notify.ts';
import { SmtpError } from '../../src/mail/smtp.ts';
import type { Product } from '../../src/products.ts';
import { standInDb } from './d1-stand-in.ts';

/**
 * The no-reply notice (shyden-labs/shydesk#18 AC2 to AC4). The copy is fixed
 * and never carries reply text, the product's monthly share is counted before
 * anything is delivered, and every failure is returned as `failed`, once, giving
 * its place in the share back (shyden-labs/shydesk#223).
 */

const LINK = 'https://shytalk.app/support#ticket=abc';
const NOW = new Date('2026-11-07T10:00:00Z');
const ABOUT = { ticketId: 't1', messageId: 'm1' };
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
  testOrigins: [],
  createdAt: 0,
});

/** A database whose counter statement returns a row while the share lasts, and a delivery that records each mail. */
function world(opts: { shareLeft: boolean; logins?: string | undefined; bounceDomain?: string }) {
  const { db, statements } = standInDb((sql) => (sql.startsWith('INSERT INTO counters') && opts.shareLeft ? [{ value: 1 }] : []));
  const env: MailEnv = {
    DB: db,
    SMTP_LOGINS: 'logins' in opts ? opts.logins : LOGINS,
    SMTP_HOST: 'mail.example',
    ...(opts.bounceDomain === undefined ? {} : { BOUNCE_DOMAIN: opts.bounceDomain }),
  };
  const deliver = vi.fn<Deliver>(() => Promise.resolve());
  return { env, statements, deliver };
}

const COUNT = {
  sql: 'INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 WHERE value < ? RETURNING value',
  values: ['mail:shytalk:2026-11', 500],
};
/** A failed send gives its place back, so only sent mail uses the share (shyden-labs/shydesk#223). */
const GIVE_BACK = { sql: 'UPDATE counters SET value = value - 1 WHERE key = ? AND value > 0', values: ['mail:shytalk:2026-11'] };

/** A failure case whose login names a malformed mail server (shyden-labs/shydesk#228). */
const badHost = (what: string, host: unknown): [string, string, string] => [
  `the login names ${what}`,
  JSON.stringify({ 'no-reply@shytalk.app': { user: 'u', pass: 'p', host } }),
  'mail for shytalk failed: the SMTP_LOGINS host for no-reply@shytalk.app is not a host name',
];

const logged = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the notice', () => {
  it('goes from the product sender, with its login, saying only that there is something new', async () => {
    const { env, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('sent');
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

  // shyden-labs/shydesk#228: a sender whose mailbox lives on another server names it.
  it("goes through the sender's own mail server when its login names one, with the login alone", async () => {
    const logins = JSON.stringify({ 'no-reply@shytalk.app': { user: 'u', pass: 'p', host: 'mail.yaweloidle.com' } });
    const { env, deliver } = world({ shareLeft: true, logins });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('sent');
    expect(deliver.mock.calls[0]?.[0]).toEqual({ user: 'u', pass: 'p' });
    expect(deliver.mock.calls[0]?.[2]).toBe('mail.yaweloidle.com');
  });
});

describe('the monthly share', () => {
  it("is counted in one capped statement on this product's month", async () => {
    const { env, statements, deliver } = world({ shareLeft: true });
    await sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT);
    expect(statements.map(({ sql, values }) => ({ sql, values }))).toEqual([COUNT]);
  });

  it('once used up, returns share-used-up and delivers nothing', async () => {
    const { env, deliver } = world({ shareLeft: false });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('share-used-up');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('of zero sends nothing and counts nothing', async () => {
    const { env, statements, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(0), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('share-used-up');
    expect(statements).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('a failure', () => {
  it.each([
    ['SMTP_LOGINS is not set', undefined, 'mail for shytalk failed: SMTP_LOGINS is not set'],
    ['SMTP_LOGINS is not JSON', 'not json', 'mail for shytalk failed: SMTP_LOGINS is not valid JSON'],
    ['the sender has no login', '{}', 'mail for shytalk failed: no SMTP login for no-reply@shytalk.app'],
    badHost('an empty host', ''),
    badHost('a host with a space', 'mail .example'),
    badHost('a host with a port', 'mail.example:587'),
    badHost('a host that is not text', 587),
  ])('when %s returns failed, names it, and delivers nothing', async (_case, logins, message) => {
    const error = logged();
    const { env, statements, deliver } = world({ shareLeft: true, logins });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([[message]]);
    expect(statements.map(({ sql, values }) => ({ sql, values }))).toEqual([COUNT, GIVE_BACK]);
  });

  it.each([
    ['a refused SMTP step', new SmtpError('rcpt', '550 no such user'), 'mail for shytalk failed: SMTP rcpt failed: 550 no such user'],
    ['a connection that cannot open', new Error('connect timed out'), 'mail for shytalk failed: connect timed out'],
  ])('on %s returns failed, names it, and delivers once', async (_case, thrown, message) => {
    const error = logged();
    const { env, statements, deliver } = world({ shareLeft: true });
    deliver.mockRejectedValueOnce(thrown);
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('failed');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(error.mock.calls).toEqual([[message]]);
    expect(statements.map(({ sql, values }) => ({ sql, values }))).toEqual([COUNT, GIVE_BACK]);
  });
});

// Each notice is written down and sent from its own bounce address, so a bounce finds its ticket (shyden-labs/shydesk#232).
describe('the bounce address', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const INSERT = 'INSERT INTO notices (id, ticket_id, message_id, to_address, sent_at) VALUES (?, ?, ?, ?, ?)';
  const DELETE = 'DELETE FROM notices WHERE id = ?';

  it('with BOUNCE_DOMAIN, inserts a notice row before delivering and sends from bounce-<id>@domain', async () => {
    const { env, statements, deliver } = world({ shareLeft: true, bounceDomain: 'bounce.example' });
    const seenBeforeDelivery: string[] = [];
    deliver.mockImplementation(() => {
      seenBeforeDelivery.push(...statements.map((s) => s.sql));
      return Promise.resolve();
    });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('sent');
    const insert = statements.find((s) => s.sql === INSERT);
    const id = insert?.values[0] as string;
    expect(id).toMatch(UUID);
    expect(insert?.values).toEqual([id, 't1', 'm1', 'pat@example.com', NOW.getTime()]);
    expect(seenBeforeDelivery).toContain(INSERT);
    const mail = deliver.mock.calls[0]?.[1];
    expect(mail?.envelopeFrom).toBe(`bounce-${id}@bounce.example`);
    expect(mail?.from).toBe('no-reply@shytalk.app');
  });

  it('gives each notice its own id', async () => {
    const { env, statements, deliver } = world({ shareLeft: true, bounceDomain: 'bounce.example' });
    await sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT);
    await sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT);
    const ids = statements.filter((s) => s.sql === INSERT).map((s) => s.values[0]);
    expect(new Set(ids).size).toBe(2);
  });

  it('records a new-ticket notice with no message', async () => {
    const { env, statements, deliver } = world({ shareLeft: true, bounceDomain: 'bounce.example' });
    await sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, { ticketId: 't2', messageId: null });
    expect(statements.find((s) => s.sql === INSERT)?.values.slice(1, 3)).toEqual(['t2', null]);
  });

  it('without BOUNCE_DOMAIN, writes no row and sets no envelopeFrom', async () => {
    const { env, statements, deliver } = world({ shareLeft: true });
    await sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT);
    expect(statements.map((s) => s.sql)).toEqual([COUNT.sql]);
    expect(deliver.mock.calls[0]?.[1]).not.toHaveProperty('envelopeFrom');
  });

  it('a failed send deletes its notice row and gives the share back', async () => {
    logged();
    const { env, statements, deliver } = world({ shareLeft: true, bounceDomain: 'bounce.example' });
    deliver.mockRejectedValueOnce(new SmtpError('rcpt', '550 no such user'));
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('failed');
    const id = statements.find((s) => s.sql === INSERT)?.values[0];
    expect(statements.map(({ sql, values }) => ({ sql, values }))).toEqual([
      COUNT,
      { sql: INSERT, values: [id, 't1', 'm1', 'pat@example.com', NOW.getTime()] },
      { sql: DELETE, values: [id] },
      GIVE_BACK,
    ]);
  });

  it('a send refused before delivery (no login) writes no row', async () => {
    logged();
    const { env, statements, deliver } = world({ shareLeft: true, bounceDomain: 'bounce.example', logins: '{}' });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('failed');
    expect(statements.map(({ sql, values }) => ({ sql, values }))).toEqual([COUNT, GIVE_BACK]);
  });

  it('a used-up share writes no row', async () => {
    const { env, statements, deliver } = world({ shareLeft: false, bounceDomain: 'bounce.example' });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('share-used-up');
    expect(statements.map((s) => s.sql)).toEqual([COUNT.sql]);
  });
});
