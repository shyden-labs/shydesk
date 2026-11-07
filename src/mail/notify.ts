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
export type Deliver = (login: SmtpLogin, mail: SmtpMail) => Promise<void>;

export interface MailEnv {
  DB: D1Database;
  /** JSON object mapping each product sender address to its `{ user, pass }`. */
  SMTP_LOGINS?: string | undefined;
}

export type NoticeResult = 'sent' | 'share-used-up' | 'failed';

const COUNT_SEND =
  'INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 WHERE value < ? RETURNING value';

/** True when this send fits in the product's share for the month of `now`, counting it; false once the share is used. */
async function countSend(db: D1Database, product: Product, now: Date): Promise<boolean> {
  if (product.monthlyEmailShare < 1) return false;
  const key = `mail:${product.id}:${now.toISOString().slice(0, 7)}`;
  return (await db.prepare(COUNT_SEND).bind(key, product.monthlyEmailShare).first()) !== null;
}

/** The sender's login from SMTP_LOGINS; throws naming what is missing or malformed. */
function senderLogin(logins: string | undefined, sender: string): SmtpLogin {
  if (logins === undefined) throw new Error('SMTP_LOGINS is not set');
  let table: Record<string, SmtpLogin>;
  try {
    table = JSON.parse(logins) as Record<string, SmtpLogin>;
  } catch {
    throw new Error('SMTP_LOGINS is not valid JSON');
  }
  const login = table[sender];
  if (login === undefined) throw new Error(`no SMTP login for ${sender}`);
  return login;
}

/** Tells the customer at `to` that their ticket has something new, linking to its private page. */
export async function sendNoReply(
  env: MailEnv,
  product: Product,
  to: string,
  link: string,
  deliver: Deliver,
  now: Date = new Date(),
): Promise<NoticeResult> {
  if (!(await countSend(env.DB, product, now))) return 'share-used-up';
  try {
    const login = senderLogin(env.SMTP_LOGINS, product.senderAddress);
    await deliver(login, {
      from: product.senderAddress,
      to,
      subject: NOTICE_SUBJECT,
      text: `${product.name} support\r\n\r\nThere is a new update on your support request. Open it here: ${link}`,
    });
    return 'sent';
  } catch (error) {
    console.error(`mail for ${product.id} failed: ${(error as Error).message}`);
    return 'failed';
  }
}
