import type { D1Database } from '@cloudflare/workers-types';
import type { Product } from '../products.ts';
import type { SmtpLogin, SmtpMail } from './smtp.ts';

/**
 * The no-reply notice a customer gets when their ticket changes
 * (shyden-labs/shydesk#18). The copy is fixed and never carries reply text:
 * it says only that there is something new, with the product name and the
 * private link. Each send counts against the product's monthly share before
 * any connection opens, and every failure comes back as `failed` for the
 * caller to show; nothing is retried.
 */

export const NOTICE_SUBJECT = 'Your support request: something new';

/** Hands one mail to the SMTP server with that sender's login (`sendSmtp` over a socket in the Worker). */
export type Deliver = (login: SmtpLogin, mail: SmtpMail) => Promise<void>;

export interface MailEnv {
  DB: D1Database;
  /** JSON `{ "<sender address>": { "user": "...", "pass": "..." } }`, one login per product sender. */
  SMTP_LOGINS?: string;
}

export type NoticeResult = 'sent' | 'share-used-up' | 'failed';

/** Counts one send in this product's month, or returns false when its share is already used. */
async function takeShare(db: D1Database, product: Product, now: Date): Promise<boolean> {
  if (product.monthlyEmailShare <= 0) return false;
  const month = now.toISOString().slice(0, 7);
  const row = await db
    .prepare(
      'INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 WHERE value < ? RETURNING value',
    )
    .bind(`mail:${product.id}:${month}`, product.monthlyEmailShare)
    .first<{ value: number }>();
  return row !== null;
}

function loginFor(logins: string | undefined, sender: string): SmtpLogin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(logins ?? '{}');
  } catch {
    throw new Error('SMTP_LOGINS is not valid JSON');
  }
  const login = (parsed as Record<string, SmtpLogin | undefined>)[sender];
  if (login === undefined) throw new Error(`no SMTP login for ${sender}`);
  return login;
}

/** Sends the notice for one ticket change to the customer. */
export async function sendNoReply(
  env: MailEnv,
  product: Product,
  to: string,
  link: string,
  deliver: Deliver,
  now = new Date(),
): Promise<NoticeResult> {
  if (!(await takeShare(env.DB, product, now))) return 'share-used-up';
  try {
    await deliver(loginFor(env.SMTP_LOGINS, product.senderAddress), {
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
