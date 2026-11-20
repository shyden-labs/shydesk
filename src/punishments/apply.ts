import type { D1Database } from '@cloudflare/workers-types';
import type { Staff } from '../auth/staff.ts';
import type { PunishmentRow } from '../db/types.ts';
import { getPunishments, hashKey } from '../products.ts';
import { send, type CallbackTarget, type Fetcher } from './send.ts';
import { base64url } from '../base64url.ts';

/**
 * Applying, re-sending and lifting punishments (shyden-labs/shydesk#60; Release 2
 * plan Task 4). A rep acts only on reports of their own products, and anything
 * outside them is not found, so nothing leaks across products. Only the admin
 * lifts (spec, "Roles"). A punishment is recorded as `sending` before it is sent,
 * so a crash mid-send leaves it visible rather than lost.
 *
 * The appeal link's token is derived from the punishment id with the ticket-link
 * key (`TICKET_TOKEN_KEY`), so "Send again" sends the same link as the first send,
 * and only the token's hash is stored. It goes in the URL's fragment, so it never
 * reaches the product's server logs.
 */

export interface PunishEnv {
  DB: D1Database;
  TICKET_TOKEN_KEY?: string;
}

/** Not this person's to see: a report or punishment outside their products, or a rep lifting. */
export class PunishmentNotFound extends Error {
  override name = 'PunishmentNotFound';
}

export type RefusalCode = 'unknown_punishment' | 'no_token_key' | 'nothing_to_send' | 'already_lifted';

/** A punishment action that cannot be done, saying why. */
export class PunishmentRefused extends Error {
  override name = 'PunishmentRefused';
  readonly code: RefusalCode;
  constructor(code: RefusalCode) {
    super(code);
    this.code = code;
  }
}

const keyBytes = (base64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(base64), (c) => Number(c.codePointAt(0)));

/** The punishment's appeal token: HMAC-SHA256 of its id under the ticket-link key, base64url. */
export async function appealToken(tokenKey: string, punishmentId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes(tokenKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`appeal:${punishmentId}`));
  return base64url(new Uint8Array(mac));
}

const marks = (list: string[]): string => list.map(() => '?').join(', ');

interface Target extends CallbackTarget {
  appealPageUrl: string | null;
}

async function targetOf(db: D1Database, productId: string): Promise<Target> {
  const row = await db
    .prepare('SELECT callback_url, callback_secret, appeal_page_url FROM products WHERE id = ?')
    .bind(productId)
    .first<{ callback_url: string | null; callback_secret: string | null; appeal_page_url: string | null }>();
  if (row === null) return { id: productId, callbackUrl: null, callbackSecret: null, appealPageUrl: null };
  return { id: productId, callbackUrl: row.callback_url, callbackSecret: row.callback_secret, appealPageUrl: row.appeal_page_url };
}

const tokenKeyOf = (env: PunishEnv): string => {
  if (!env.TICKET_TOKEN_KEY) throw new PunishmentRefused('no_token_key');
  return env.TICKET_TOKEN_KEY;
};

async function appealUrlOf(target: Target, tokenKey: string, punishmentId: string): Promise<string | null> {
  return target.appealPageUrl === null ? null : `${target.appealPageUrl}#appeal=${await appealToken(tokenKey, punishmentId)}`;
}

/** A punishment in this person's products, or null. */
export async function findPunishment(db: D1Database, staff: Staff, id: string): Promise<PunishmentRow | null> {
  if (staff.products.length === 0) return null;
  return db
    .prepare(`SELECT * FROM punishments WHERE id = ? AND product_id IN (${marks(staff.products)})`)
    .bind(id, ...staff.products)
    .first<PunishmentRow>();
}

/** A punishment in this person's products, or PunishmentNotFound. */
async function punishmentInScope(db: D1Database, staff: Staff, id: string): Promise<PunishmentRow> {
  const row = await findPunishment(db, staff, id);
  if (row === null) throw new PunishmentNotFound();
  return row;
}

/** Records one of the product's punishments on a report in this person's products, then sends it. */
export async function applyPunishment(
  env: PunishEnv,
  staff: Staff,
  reportTicketId: string,
  key: string,
  fetcher?: Fetcher,
  now = Date.now(),
): Promise<PunishmentRow> {
  const report =
    staff.products.length === 0
      ? null
      : await env.DB.prepare(
          `SELECT t.id, t.product_id, r.subject_user_id
           FROM tickets t JOIN reports r ON r.ticket_id = t.id WHERE t.id = ? AND t.product_id IN (${marks(staff.products)})`,
        )
          .bind(reportTicketId, ...staff.products)
          .first<{ id: string; product_id: string; subject_user_id: string }>();
  if (report === null) throw new PunishmentNotFound();
  const def = (await getPunishments(env.DB, report.product_id)).find((p) => p.key === key);
  if (def === undefined) throw new PunishmentRefused('unknown_punishment');
  const tokenKey = tokenKeyOf(env);

  const id = crypto.randomUUID();
  const row: PunishmentRow = {
    id,
    product_id: report.product_id,
    report_ticket_id: report.id,
    subject_user_id: report.subject_user_id,
    punishment_key: def.key,
    label: def.label,
    duration_seconds: def.duration_seconds,
    applied_by: staff.email,
    created_at: now,
    send_state: 'sending',
    send_error: null,
    appeal_token_hash: await hashKey(await appealToken(tokenKey, id)),
    lifted_at: null,
    lifted_by: null,
    lift_state: null,
    lift_error: null,
  };
  await env.DB.prepare(
    `INSERT INTO punishments (id, product_id, report_ticket_id, subject_user_id, punishment_key, label, duration_seconds,
       applied_by, created_at, send_state, appeal_token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.product_id,
      row.report_ticket_id,
      row.subject_user_id,
      row.punishment_key,
      row.label,
      row.duration_seconds,
      row.applied_by,
      row.created_at,
      row.send_state,
      row.appeal_token_hash,
    )
    .run();
  const target = await targetOf(env.DB, row.product_id);
  row.send_state = await send(env.DB, target, row, 'punishment.apply', await appealUrlOf(target, tokenKey, id), fetcher, now);
  return row;
}

/** "Send again": re-sends whichever send failed, with the same punishment id, and says how it went. A failed lift is the admin's to re-send. */
export async function resendPunishment(
  env: PunishEnv,
  staff: Staff,
  punishmentId: string,
  fetcher?: Fetcher,
  now = Date.now(),
): Promise<'applied' | 'failed'> {
  const row = await punishmentInScope(env.DB, staff, punishmentId);
  const target = await targetOf(env.DB, row.product_id);
  if (row.lift_state === 'failed') {
    if (staff.role !== 'admin') throw new PunishmentNotFound();
    await env.DB.prepare("UPDATE punishments SET lift_state = 'sending', lift_error = NULL WHERE id = ?").bind(row.id).run();
    return send(env.DB, target, row, 'punishment.lift', null, fetcher, now);
  }
  // A lifted punishment's apply is never sent again: it would put back what the admin took off.
  if (row.lifted_at !== null) throw new PunishmentRefused('already_lifted');
  if (row.send_state !== 'failed') throw new PunishmentRefused('nothing_to_send');
  const tokenKey = tokenKeyOf(env);
  await env.DB.prepare("UPDATE punishments SET send_state = 'sending', send_error = NULL WHERE id = ?").bind(row.id).run();
  return send(env.DB, target, row, 'punishment.apply', await appealUrlOf(target, tokenKey, row.id), fetcher, now);
}

/** Lifts a punishment, tells the product and says how it went. The admin's alone: a rep gets PunishmentNotFound. */
export async function liftPunishment(
  env: PunishEnv,
  staff: Staff,
  punishmentId: string,
  fetcher?: Fetcher,
  now = Date.now(),
): Promise<'applied' | 'failed'> {
  if (staff.role !== 'admin') throw new PunishmentNotFound();
  const row = await punishmentInScope(env.DB, staff, punishmentId);
  if (row.lifted_at !== null) throw new PunishmentRefused('already_lifted');
  await env.DB.prepare("UPDATE punishments SET lifted_at = ?, lifted_by = ?, lift_state = 'sending' WHERE id = ? AND lifted_at IS NULL")
    .bind(now, staff.email, row.id)
    .run();
  return send(env.DB, await targetOf(env.DB, row.product_id), row, 'punishment.lift', null, fetcher, now);
}
