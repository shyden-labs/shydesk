import type { D1Database } from '@cloudflare/workers-types';
import type { Product } from '../products.ts';
import type { SmtpLogin, SmtpMail } from './smtp.ts';

/**
 * The no-reply notice sent when a ticket changes (shyden-labs/shydesk#18).
 * Its copy is fixed: the product name, that there is something new, and the
 * private link, never any reply text. A send is counted against the
 * product's monthly share before anything is delivered, and a failure is
 * returned as `failed` for the caller to show; nothing is sent twice.
 */

export const NOTICE_SUBJECT = 'Your support request: something new';

/** Hands one mail to the SMTP server under the sender's login. In the Worker: `sendSmtp` over a socket. */
/** `host` is the Worker's SMTP_HOST setting, which may be unset; a Deliver refuses to send without it. */
export type Deliver = (login: SmtpLogin, mail: SmtpMail, host: string | undefined) => Promise<void>;

export interface MailEnv {
  DB: D1Database;
  /** JSON object mapping each product sender address to its `{ user, pass }`, plus `host` when its mailbox is not on SMTP_HOST. */
  SMTP_LOGINS?: string | undefined;
  /** The mail host every product sends through (Sparked Host), on port 587 (shyden-labs/shydesk#68). */
  SMTP_HOST?: string | undefined;
  /** The domain bounces come back to (shyden-labs/shydesk#232); unset, notices are sent as before and not written down. */
  BOUNCE_DOMAIN?: string | undefined;
}

/** The ticket a notice is about, and the reply it announces (null for a new ticket or appeal). */
export interface NoticeAbout {
  ticketId: string;
  messageId: string | null;
  /** Said before the link (shyden-labs/shydesk#263: the test-version reply); nothing when left out. */
  lead?: string;
}

export type NoticeResult = 'sent' | 'share-used-up' | 'failed';

const COUNT_SEND =
  'INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 WHERE value < ? RETURNING value';

/** Gives a failed send's place back, so the share counts only mail that was sent (shyden-labs/shydesk#223). */
const GIVE_BACK = 'UPDATE counters SET value = value - 1 WHERE key = ? AND value > 0';

const INSERT_NOTICE = 'INSERT INTO notices (id, ticket_id, message_id, to_address, sent_at) VALUES (?, ?, ?, ?, ?)';
/** A notice that never left is not shown as sent. */
const DELETE_NOTICE = 'DELETE FROM notices WHERE id = ?';

/** The product's share counter for the month of `now`. */
function shareKey(product: Product, now: Date): string {
  return `mail:${product.id}:${now.toISOString().slice(0, 7)}`;
}

/** True when this send fits in the product's share for the month of `now`, counting it; false once the share is used. */
async function countSend(db: D1Database, product: Product, now: Date): Promise<boolean> {
  if (product.monthlyEmailShare < 1) return false;
  return (await db.prepare(COUNT_SEND).bind(shareKey(product, now), product.monthlyEmailShare).first()) !== null;
}

/** One SMTP_LOGINS entry: the login, and the mail server when the sender's mailbox is not on SMTP_HOST (shyden-labs/shydesk#228). */
type LoginEntry = SmtpLogin & { host?: unknown };

/** A bare host name: letters, digits, dots and hyphens, no port or spaces. */
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** The sender's login and its own mail server, if it names one, from SMTP_LOGINS; throws naming what is missing or malformed. */
function senderLogin(logins: string | undefined, sender: string): { login: SmtpLogin; host: string | undefined } {
  if (logins === undefined) throw new Error('SMTP_LOGINS is not set');
  let table: Record<string, LoginEntry>;
  try {
    table = JSON.parse(logins) as Record<string, LoginEntry>;
  } catch {
    throw new Error('SMTP_LOGINS is not valid JSON');
  }
  const entry = table[sender];
  if (entry === undefined) throw new Error(`no SMTP login for ${sender}`);
  const { host, user, pass } = entry;
  if (host !== undefined && (typeof host !== 'string' || !HOST_NAME.test(host))) {
    throw new Error(`the SMTP_LOGINS host for ${sender} is not a host name`);
  }
  return { login: { user, pass }, host };
}

/** Tells the customer at `to` that their ticket has something new, linking to its private page. */
export async function sendNoReply(
  env: MailEnv,
  product: Product,
  to: string,
  link: string,
  deliver: Deliver,
  now: Date,
  about: NoticeAbout,
): Promise<NoticeResult> {
  if (!(await countSend(env.DB, product, now))) return 'share-used-up';
  let noticeId: string | null = null;
  try {
    const { login, host } = senderLogin(env.SMTP_LOGINS, product.senderAddress);
    const mail: SmtpMail = {
      from: product.senderAddress,
      to,
      subject: NOTICE_SUBJECT,
      text: `${product.name} support\r\n\r\n${about.lead === undefined ? '' : `${about.lead}\r\n\r\n`}There is a new update on your support request. Open it here: ${link}`,
    };
    // Written down before it leaves, so a bounce that comes back fast finds its row (shyden-labs/shydesk#232).
    if (env.BOUNCE_DOMAIN !== undefined) {
      noticeId = crypto.randomUUID();
      await env.DB.prepare(INSERT_NOTICE).bind(noticeId, about.ticketId, about.messageId, to, now.getTime()).run();
      mail.envelopeFrom = `bounce-${noticeId}@${env.BOUNCE_DOMAIN}`;
    }
    await deliver(login, mail, host ?? env.SMTP_HOST);
    return 'sent';
  } catch (error) {
    console.error(`mail for ${product.id} failed: ${(error as Error).message}`);
    if (noticeId !== null) await env.DB.prepare(DELETE_NOTICE).bind(noticeId).run();
    await env.DB.prepare(GIVE_BACK).bind(shareKey(product, now)).run();
    return 'failed';
  }
}
