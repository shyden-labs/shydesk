import type { D1Database } from '@cloudflare/workers-types';
import { sealToken } from './seal.ts';
import { hashKey } from '../products.ts';

/**
 * A new ticket from the contact form (shyden-labs/shydesk#19). The customer's
 * private token is 32 random bytes, base64url (43 characters), returned once;
 * only its SHA-256 is stored. The ticket, its first message and its
 * attachments are written in one batch, on the next feed seq.
 */

export interface NewTicket {
  productId: string;
  typeId: string;
  email: string;
  subject: string;
  category: string;
  message: string;
  fields: Record<string, string>;
  attachmentIds: string[];
  now: number;
  /** TICKET_TOKEN_KEY, which seals the copy of the token that reply emails link with. */
  tokenKey: string;
}

/** An attachment that is not this product's, not finished uploading, or already on a ticket. */
export class AttachmentError extends Error {
  override name = 'AttachmentError';
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

export const newToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** The customer's private link: the product's ticket page with the token in the fragment, so no server logs it. */
export const ticketLink = (ticketPageUrl: string, token: string): string => `${ticketPageUrl}#t=${token}`;

export const USABLE = "product_id = ? AND state = 'stored' AND ticket_id IS NULL";

export async function refuseUnusable(db: D1Database, productId: string, ids: string[]): Promise<void> {
  const marks = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id FROM attachments WHERE id IN (${marks}) AND ${USABLE}`)
    .bind(...ids, productId)
    .all<{ id: string }>();
  if (results.length !== ids.length) throw new AttachmentError('An attachment could not be found. Upload it again.');
}

export async function createTicket(db: D1Database, t: NewTicket): Promise<{ id: string; token: string }> {
  const attachmentIds = [...new Set(t.attachmentIds)];
  if (attachmentIds.length > 0) await refuseUnusable(db, t.productId, attachmentIds);
  const id = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const token = newToken();
  const statements = [
    db.prepare(`INSERT INTO counters (key, value) VALUES ('feed_seq', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1`),
    db
      .prepare(
        `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, token_sealed, created_at, updated_at, seq)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, (SELECT value FROM counters WHERE key = 'feed_seq'))`,
      )
      .bind(
        id,
        t.productId,
        t.typeId,
        t.email.toLowerCase(),
        t.subject,
        t.category,
        JSON.stringify(t.fields),
        await hashKey(token),
        await sealToken(t.tokenKey, token),
        t.now,
        t.now,
      ),
    db
      .prepare("INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES (?, ?, 'customer', NULL, ?, ?)")
      .bind(messageId, id, t.message, t.now),
  ];
  if (attachmentIds.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE attachments SET ticket_id = ?, message_id = ? WHERE id IN (${attachmentIds.map(() => '?').join(', ')}) AND ${USABLE}`,
        )
        .bind(id, messageId, ...attachmentIds, t.productId),
    );
  }
  await db.batch(statements);
  return { id, token };
}
