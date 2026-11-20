import type { D1Database } from '@cloudflare/workers-types';
import type { Staff } from '../auth/staff.ts';
import { MESSAGES } from '../customer/messages.ts';
import { hashKey } from '../products.ts';
import { liftPunishment, type PunishEnv } from '../punishments/apply.ts';
import type { Fetcher } from '../punishments/send.ts';
import { ticketStatements } from '../tickets/create.ts';
import { isEmailAddress } from '../email-address.ts';

/**
 * Appeals (shyden-labs/shydesk#61; Release 2 plan Task 5). A punished user
 * appeals once, from the link in the ban notice (`#appeal=<token>`, read by the
 * shared piece) or from inside the product (its server names the punishment id).
 * The appeal is a ticket of kind `appeal` plus an `appeals` row whose primary key
 * is the punishment id, written in one batch: a second appeal, even one sent at
 * the same moment, fails as a whole and is refused as `already_appealed`. Once
 * rejected, no further appeal is taken, and a lifted punishment takes none.
 * Only the admin sees or decides appeals; the desk queries leave them out for a
 * rep in SQL (src/desk/queries.ts).
 */

export const appealTypeId = (productId: string): string => `${productId}:appeal`;

/** A punishment as an appeal sees it. `appealed` is 1 once an appeal row exists, whatever its outcome. */
export interface Appealable {
  id: string;
  product_id: string;
  label: string;
  created_at: number;
  lifted_at: number | null;
  appealed: number;
}

export type AppealReason = 'already_appealed' | 'lifted';

export interface AppealStatus {
  label: string;
  created_at: number;
  can_appeal: boolean;
  reason?: AppealReason;
}

/** Not this person's to see: a rep, or an appeal outside the admin's products. */
export class AppealNotFound extends Error {
  override name = 'AppealNotFound';
}

/** An appeal that cannot be made or decided, saying why. */
export class AppealRefused extends Error {
  override name = 'AppealRefused';
  readonly code: AppealReason | 'already_decided';
  constructor(code: AppealReason | 'already_decided') {
    super(code);
    this.code = code;
  }
}

const SELECT = `SELECT p.id, p.product_id, p.label, p.created_at, p.lifted_at, a.punishment_id IS NOT NULL AS appealed
  FROM punishments p LEFT JOIN appeals a ON a.punishment_id = p.id`;

/** The product's punishment named by its appeal token or its id, or null. */
export async function findAppealable(
  db: D1Database,
  productId: string,
  by: { token: string } | { punishmentId: string },
): Promise<Appealable | null> {
  if ('token' in by) {
    if (by.token === '') return null;
    return db
      .prepare(`${SELECT} WHERE p.appeal_token_hash = ? AND p.product_id = ?`)
      .bind(await hashKey(by.token), productId)
      .first<Appealable>();
  }
  if (by.punishmentId === '') return null;
  return db.prepare(`${SELECT} WHERE p.id = ? AND p.product_id = ?`).bind(by.punishmentId, productId).first<Appealable>();
}

const refusal = (p: Appealable): AppealReason | null => {
  if (p.appealed) return 'already_appealed';
  if (p.lifted_at !== null) return 'lifted';
  return null;
};

/** Whether the punishment can still be appealed, and if not, why. */
export function appealStatus(p: Appealable): AppealStatus {
  const reason = refusal(p);
  const status: AppealStatus = { label: p.label, created_at: p.created_at, can_appeal: reason === null };
  if (reason !== null) status.reason = reason;
  return status;
}

const MAX_MESSAGE = 10_000;
const MAX_EMAIL = 254;

export interface AppealInput {
  email: string;
  message: string;
}

export type ParsedAppeal =
  { ok: true; value: AppealInput } | { ok: false; errors: Record<string, string> } | { ok: false; unreadable: true };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The appeal's email and message, or every field in error at once, or that it could not be read. */
export function parseAppeal(body: unknown): ParsedAppeal {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, unreadable: true };
  const given = body as Record<string, unknown>;
  const value: AppealInput = { email: text(given.email).toLowerCase(), message: text(given.message) };
  const errors: Record<string, string> = {};
  if (value.email.length > MAX_EMAIL || !isEmailAddress(value.email)) errors.email = MESSAGES.emailInvalid;
  if (value.message === '') errors.message = MESSAGES.messageRequired;
  else if (value.message.length > MAX_MESSAGE) errors.message = MESSAGES.messageTooLong;
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

const isSecondAppeal = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: appeals\.punishment_id/.test(error.message);

/** Makes the appeal ticket and its appeal row in one batch, returning the ticket's id and private token. */
export async function createAppeal(
  db: D1Database,
  p: Appealable,
  input: AppealInput,
  tokenKey: string,
  now = Date.now(),
): Promise<{ id: string; token: string }> {
  const reason = refusal(p);
  if (reason !== null) throw new AppealRefused(reason);
  const typeId = appealTypeId(p.product_id);
  const ticket = await ticketStatements(db, {
    productId: p.product_id,
    typeId,
    email: input.email,
    subject: `Appeal: ${p.label}`,
    category: 'appeal',
    message: input.message,
    fields: { punishment_id: p.id },
    attachmentIds: [],
    now,
    tokenKey,
  });
  try {
    await db.batch([
      db
        .prepare(
          'INSERT OR IGNORE INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(typeId, p.product_id, 'appeal', 'Appeal', '[]', '[]', 1),
      ...ticket.statements,
      db.prepare("INSERT INTO appeals (punishment_id, ticket_id, state) VALUES (?, ?, 'open')").bind(p.id, ticket.id),
    ]);
  } catch (error) {
    if (isSecondAppeal(error)) throw new AppealRefused('already_appealed');
    throw error;
  }
  return { id: ticket.id, token: ticket.token };
}

const marks = (list: string[]): string => list.map(() => '?').join(', ');

/**
 * The admin's decision on an appeal. `upheld` lifts the punishment and sends one
 * `punishment.lift`, answering how that send went; if the admin had already
 * lifted it, nothing is sent and the answer is `upheld`. `rejected` sends nothing.
 */
export async function decideAppeal(
  env: PunishEnv,
  staff: Staff,
  ticketId: string,
  outcome: 'upheld' | 'rejected',
  fetcher?: Fetcher,
  now = Date.now(),
): Promise<'applied' | 'failed' | 'upheld' | 'rejected'> {
  if (staff.role !== 'admin' || staff.products.length === 0) throw new AppealNotFound();
  const appeal = await env.DB.prepare(
    `SELECT a.punishment_id, a.ticket_id, a.state, t.product_id, p.lifted_at
     FROM appeals a JOIN tickets t ON t.id = a.ticket_id JOIN punishments p ON p.id = a.punishment_id
     WHERE a.ticket_id = ? AND t.product_id IN (${marks(staff.products)})`,
  )
    .bind(ticketId, ...staff.products)
    .first<{ punishment_id: string; ticket_id: string; state: string; product_id: string; lifted_at: number | null }>();
  if (appeal === null) throw new AppealNotFound();
  if (appeal.state !== 'open') throw new AppealRefused('already_decided');
  // Two decisions at the same moment: only the one that changed the row goes on.
  const decided = await env.DB.prepare(
    "UPDATE appeals SET state = ?, decided_by = ?, decided_at = ? WHERE ticket_id = ? AND state = 'open' RETURNING ticket_id",
  )
    .bind(outcome, staff.email, now, appeal.ticket_id)
    .first();
  if (decided === null) throw new AppealRefused('already_decided');
  if (outcome === 'rejected') return 'rejected';
  if (appeal.lifted_at !== null) return 'upheld';
  return liftPunishment(env, staff, appeal.punishment_id, fetcher, now);
}
