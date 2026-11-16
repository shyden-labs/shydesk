import type { D1Database } from '@cloudflare/workers-types';
import type { PunishmentRow } from '../db/types.ts';
import { sign } from './sign.ts';

/**
 * Sends a punishment, or its lift, to the product (shyden-labs/shydesk#60; Release 2
 * plan Task 4). One signed POST to the product's callback, given up after 10 s. It
 * is `applied` only on a 200 whose body has `applied: true`; anything else is
 * `failed`, with the reason: `timeout`, `network_error`, `http_<status>` and the
 * product's `error` code when it gives one, `not_applied`, or `no_callback` when
 * the product has no callback or secret set. ShyDesk never sends twice by itself:
 * a person presses "Send again" (spec, "Punishments"). The product is idempotent
 * on `punishment_id`.
 */

export const CALLBACK_TIMEOUT_MS = 10_000;

export type SendType = 'punishment.apply' | 'punishment.lift';
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Where a product's punishments go, and the secret they are signed with. */
export interface CallbackTarget {
  id: string;
  callbackUrl: string | null;
  callbackSecret: string | null;
}

class Timeout extends Error {
  override name = 'Timeout';
}

/** The product's `error` code from an answer, if it gives one as JSON. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

async function appliedFlag(response: Response): Promise<boolean> {
  try {
    return ((await response.json()) as { applied?: unknown }).applied === true;
  } catch {
    return false;
  }
}

/** Posts the body, and why it failed, or null when the product applied it. */
async function post(target: { url: string; secret: string }, raw: string, fetcher: Fetcher, now: number): Promise<string | null> {
  const timestamp = Math.floor(now / 1000);
  const headers = {
    'Content-Type': 'application/json',
    'ShyDesk-Timestamp': String(timestamp),
    'ShyDesk-Signature': await sign(target.secret, timestamp, raw),
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race stops waiting even if a fetcher ignores the abort signal.
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Timeout());
    }, CALLBACK_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetcher(target.url, { method: 'POST', body: raw, signal: controller.signal, headers }), timedOut]);
    if (response.status !== 200) {
      const code = await errorCode(response);
      return code === null ? `http_${String(response.status)}` : `http_${String(response.status)} ${code}`;
    }
    return (await appliedFlag(response)) ? null : 'not_applied';
  } catch (error) {
    return error instanceof Timeout ? 'timeout' : 'network_error';
  } finally {
    clearTimeout(timer);
  }
}

/** Sends once and records the outcome in the punishment's send or lift columns. */
export async function send(
  db: D1Database,
  target: CallbackTarget,
  punishment: PunishmentRow,
  type: SendType,
  appealUrl: string | null,
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<'applied' | 'failed'> {
  const body = {
    type,
    punishment_id: punishment.id,
    product: target.id,
    subject_user_id: punishment.subject_user_id,
    punishment: { key: punishment.punishment_key, label: punishment.label, duration_seconds: punishment.duration_seconds },
    report_ticket_id: punishment.report_ticket_id,
    ...(type === 'punishment.apply' && appealUrl !== null ? { appeal_url: appealUrl } : {}),
    issued_at: punishment.created_at,
  };
  const error =
    target.callbackUrl === null || target.callbackSecret === null
      ? 'no_callback'
      : await post({ url: target.callbackUrl, secret: target.callbackSecret }, JSON.stringify(body), fetcher, now);
  const state = error === null ? 'applied' : 'failed';
  const columns = type === 'punishment.apply' ? 'send_state = ?, send_error = ?' : 'lift_state = ?, lift_error = ?';
  await db.prepare(`UPDATE punishments SET ${columns} WHERE id = ?`).bind(state, error, punishment.id).run();
  return state;
}
