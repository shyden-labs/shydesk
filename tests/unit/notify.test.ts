import { afterEach, describe, expect, it, vi } from 'vitest';
import { noticeSubject, sendNoReply, type Deliver, type MailEnv } from '../../src/mail/notify.ts';
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
  it("goes from the product sender, with its login, with one wording for every notice: the product's support request and its link (shyden-labs/shydesk#272)", async () => {
    const { env, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('sent');
    expect(deliver.mock.calls).toEqual([
      [
        { user: 'u', pass: 'p' },
        {
          from: 'no-reply@shytalk.app',
          fromName: 'ShyTalk support',
          to: 'pat@example.com',
          subject: 'Your ShyTalk support request',
          text: `ShyTalk support\r\n\r\nYour support request can be viewed here: ${LINK}`,
        },
        // The Worker's mail host (shyden-labs/shydesk#68).
        'mail.example',
      ],
    ]);
    expect(noticeSubject('Yawelo Idle')).toBe('Your Yawelo Idle support request');
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

  it('once used up, returns share-used-up, delivers nothing, and logs one line naming the product and its share', async () => {
    const error = logged();
    const { env, deliver } = world({ shareLeft: false });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('share-used-up');
    expect(deliver).not.toHaveBeenCalled();
    // shyden-labs/shydesk#274 AC2: never silent, and no customer address in the log.
    expect(error.mock.calls).toEqual([['mail for shytalk not sent: its monthly email share of 500 is used up']]);
  });

  it('of zero sends nothing, counts nothing, and logs the share of 0', async () => {
    const error = logged();
    const { env, statements, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(0), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('share-used-up');
    expect(statements).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([['mail for shytalk not sent: its monthly email share of 0 is used up']]);
  });
});

// A new ticket's first email that did not go is noted on the ticket for the desk (shyden-labs/shydesk#274 AC1).
describe("a new ticket's first email that is not sent", () => {
  const FIRST = { ticketId: 't1', messageId: null };
  const NOTE = (why: string) => ({ sql: 'UPDATE tickets SET first_notice_unsent = ? WHERE id = ?', values: [why, 't1'] });
  const written = (statements: { sql: string; values: unknown[] }[]) => statements.map(({ sql, values }) => ({ sql, values }));

  it('notes share-used-up on the ticket', async () => {
    logged();
    const { env, statements, deliver } = world({ shareLeft: false });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, FIRST)).resolves.toBe('share-used-up');
    expect(written(statements)).toEqual([COUNT, NOTE('share-used-up')]);
  });

  it('notes share-used-up on the ticket when the share is 0', async () => {
    logged();
    const { env, statements, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(0), 'pat@example.com', LINK, deliver, NOW, FIRST)).resolves.toBe('share-used-up');
    expect(written(statements)).toEqual([NOTE('share-used-up')]);
  });

  it('notes failed on the ticket after giving the share back', async () => {
    logged();
    const { env, statements, deliver } = world({ shareLeft: true });
    deliver.mockRejectedValueOnce(new Error('connect timed out'));
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, FIRST)).resolves.toBe('failed');
    expect(written(statements)).toEqual([COUNT, GIVE_BACK, NOTE('failed')]);
  });

  it('notes nothing when it is sent', async () => {
    const { env, statements, deliver } = world({ shareLeft: true });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, FIRST)).resolves.toBe('sent');
    expect(written(statements)).toEqual([COUNT]);
  });

  it("notes nothing on the ticket for a reply's email that is not sent", async () => {
    logged();
    const { env, statements, deliver } = world({ shareLeft: false });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('share-used-up');
    expect(written(statements)).toEqual([COUNT]);
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
    // The logs keep no personal data: the customer's address is replaced in any letter case (shyden-labs/shydesk#306).
    [
      'a refusal that quotes the address',
      new SmtpError('rcpt', '550 5.1.1 <Pat@Example.com>: user unknown, pat@example.com'),
      'mail for shytalk failed: SMTP rcpt failed: 550 5.1.1 <[recipient]>: user unknown, [recipient]',
    ],
    ['any error that quotes the address', new Error('no route to pat@example.com'), 'mail for shytalk failed: no route to [recipient]'],
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

// An address holding a regular-expression character is matched as plain text (shyden-labs/shydesk#306).
it('keeps an address holding + out of the failure log', async () => {
  const error = logged();
  const { env, deliver } = world({ shareLeft: true });
  deliver.mockRejectedValueOnce(new SmtpError('rcpt', '550 <pat+tag@example.com> refused'));
  await expect(sendNoReply(env, shytalk(), 'pat+tag@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('failed');
  expect(error.mock.calls).toEqual([['mail for shytalk failed: SMTP rcpt failed: 550 <[recipient]> refused']]);
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
    logged();
    const { env, statements, deliver } = world({ shareLeft: false, bounceDomain: 'bounce.example' });
    await expect(sendNoReply(env, shytalk(), 'pat@example.com', LINK, deliver, NOW, ABOUT)).resolves.toBe('share-used-up');
    expect(statements.map((s) => s.sql)).toEqual([COUNT.sql]);
  });
});
