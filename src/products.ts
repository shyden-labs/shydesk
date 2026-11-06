import type { D1Database } from '@cloudflare/workers-types';
import type { Role } from './auth/staff.ts';

/**
 * Products and their settings, kept by admins on screen so self-hosters
 * configure ShyDesk without a deploy (shyden-labs/shydesk#17; plan Task 4).
 */

/** A product as an admin enters it. */
export interface ProductInput {
  /** Stable id used in URLs and the shared piece's `product` attribute. */
  id: string;
  name: string;
  /** The no-reply address customer emails come from, on the product's own domain. */
  senderAddress: string;
  /** The product's page that shows a ticket from its private link. */
  ticketPageUrl: string;
  /** Exact `https://host[:port]` origins allowed to embed the shared piece. */
  allowedOrigins: string[];
  /** ShyDesk's own monthly email cap for this product. */
  monthlyEmailShare: number;
  attachmentsKeepDays: number;
  textKeepDays: number;
}

const PRODUCT_ID = /^[a-z0-9-]{2,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9.-]+$/;
const ROLES: readonly string[] = ['admin', 'rep'];
const FIELD_KINDS: readonly string[] = ['text', 'select'];

/** True when `id` is a valid product id. */
export const isProductId = (id: string): boolean => PRODUCT_ID.test(id);

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** True when `origin` is written exactly as its own canonical `https://host[:port]`. */
export function isExactOrigin(origin: string): boolean {
  const url = parse(origin);
  return url !== null && url.protocol === 'https:' && HOST.test(url.hostname) && url.origin === origin;
}

const isWhole = (n: number, min: number): boolean => Number.isInteger(n) && n >= min;

/** Every rule the product breaks, in form order; empty when it is valid. */
export function validateProduct(p: ProductInput): string[] {
  const errors: string[] = [];
  if (!isProductId(p.id)) errors.push('Product id must be 2 to 40 lowercase letters, digits or hyphens.');
  if (!p.name.trim()) errors.push('Name is required.');
  if (!EMAIL.test(p.senderAddress)) errors.push('Sender address must be an email address ending in a domain.');
  const page = parse(p.ticketPageUrl);
  const pageOk = page !== null && page.protocol === 'https:' && !p.ticketPageUrl.includes('#');
  if (!pageOk) errors.push('Ticket page URL must be an https address with no #fragment.');
  if (p.allowedOrigins.length === 0) errors.push('At least one allowed origin is required.');
  for (const origin of p.allowedOrigins) {
    if (!isExactOrigin(origin)) errors.push(`Allowed origin "${origin}" must be exactly https://host or https://host:port.`);
  }
  if (pageOk && p.allowedOrigins.length > 0 && !p.allowedOrigins.includes(page.origin)) {
    errors.push("The ticket page URL's origin must be one of the allowed origins.");
  }
  if (!isWhole(p.monthlyEmailShare, 0)) errors.push('Monthly email share must be a whole number of 0 or more.');
  if (!isWhole(p.attachmentsKeepDays, 1)) errors.push('Attachment keep-days must be a whole number of 1 or more.');
  if (!isWhole(p.textKeepDays, 1)) errors.push('Text keep-days must be a whole number of 1 or more.');
  return errors;
}

/** A settings change refused, with every reason, in form order. */
export class SettingsError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join(' '));
    this.name = 'SettingsError';
    this.errors = errors;
  }
}

const refuseIfAny = (errors: string[]): void => {
  if (errors.length > 0) throw new SettingsError(errors);
};

/** A stored product. */
export interface Product extends ProductInput {
  createdAt: number;
}

interface ProductRow {
  id: string;
  name: string;
  sender_address: string;
  ticket_page_url: string;
  allowed_origins_json: string;
  monthly_email_share: number;
  attachments_keep_days: number;
  text_keep_days: number;
  created_at: number;
}

const fromRow = (r: ProductRow): Product => ({
  id: r.id,
  name: r.name,
  senderAddress: r.sender_address,
  ticketPageUrl: r.ticket_page_url,
  allowedOrigins: JSON.parse(r.allowed_origins_json) as string[],
  monthlyEmailShare: r.monthly_email_share,
  attachmentsKeepDays: r.attachments_keep_days,
  textKeepDays: r.text_keep_days,
  createdAt: r.created_at,
});

const PRODUCT_COLUMNS =
  'id, name, sender_address, ticket_page_url, allowed_origins_json, monthly_email_share, attachments_keep_days, text_keep_days, created_at';

/** Adds a product, or updates it in place keeping when it was created. Throws SettingsError. */
export async function saveProduct(db: D1Database, p: ProductInput, now = Date.now()): Promise<void> {
  refuseIfAny(validateProduct(p));
  await db
    .prepare(
      `INSERT INTO products (${PRODUCT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, sender_address = excluded.sender_address,
         ticket_page_url = excluded.ticket_page_url, allowed_origins_json = excluded.allowed_origins_json,
         monthly_email_share = excluded.monthly_email_share, attachments_keep_days = excluded.attachments_keep_days,
         text_keep_days = excluded.text_keep_days`,
    )
    .bind(
      p.id,
      p.name.trim(),
      p.senderAddress,
      p.ticketPageUrl,
      JSON.stringify(p.allowedOrigins),
      p.monthlyEmailShare,
      p.attachmentsKeepDays,
      p.textKeepDays,
      now,
    )
    .run();
}

export async function getProduct(db: D1Database, id: string): Promise<Product | null> {
  const row = await db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).bind(id).first<ProductRow>();
  return row ? fromRow(row) : null;
}

export async function listProducts(db: D1Database): Promise<Product[]> {
  const { results } = await db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY id`).all<ProductRow>();
  return results.map(fromRow);
}

/** The product, only when `origin` is one of its allowed origins; null otherwise. */
export async function productForOrigin(db: D1Database, productId: string, origin: string): Promise<Product | null> {
  const product = await getProduct(db, productId);
  return product?.allowedOrigins.includes(origin) ? product : null;
}

/** One error per id in `ids` with no product. */
async function missingProducts(db: D1Database, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .bind(...ids)
    .all<{ id: string }>();
  const found = new Set(results.map((r) => r.id));
  return ids.filter((id) => !found.has(id)).map((id) => `No such product: ${id}.`);
}

export interface StaffInput {
  email: string;
  role: Role;
  /** A rep's grants; ignored for an admin, who sees every product. */
  products: string[];
}

/** Adds or updates a staff member and replaces a rep's grants, together. Throws SettingsError. */
export async function saveStaff(db: D1Database, s: StaffInput, now = Date.now()): Promise<void> {
  const email = s.email.trim().toLowerCase();
  const errors: string[] = [];
  if (!EMAIL.test(email)) errors.push('Email must be an email address ending in a domain.');
  // Form input arrives untyped, so the role is checked at run time too.
  if (!ROLES.includes(s.role)) errors.push('Role must be admin or rep.');
  const grants = s.role === 'rep' ? [...new Set(s.products)] : [];
  errors.push(...(await missingProducts(db, grants)));
  refuseIfAny(errors);
  await db.batch([
    db
      .prepare('INSERT INTO staff (email, role, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role')
      .bind(email, s.role, now),
    db.prepare('DELETE FROM staff_products WHERE email = ?').bind(email),
    ...grants.map((id) => db.prepare('INSERT INTO staff_products (email, product_id) VALUES (?, ?)').bind(email, id)),
  ]);
}

export async function listStaff(db: D1Database): Promise<StaffInput[]> {
  const staff = await db.prepare('SELECT email, role FROM staff ORDER BY email').all<{ email: string; role: Role }>();
  const grants = await db
    .prepare('SELECT email, product_id FROM staff_products ORDER BY email, product_id')
    .all<{ email: string; product_id: string }>();
  return staff.results.map((s) => ({
    email: s.email,
    role: s.role,
    products: grants.results.filter((g) => g.email === s.email).map((g) => g.product_id),
  }));
}

/** An extra field on a product's support form. */
export interface SupportField {
  label: string;
  kind: 'text' | 'select';
  required: boolean;
  /** A choice list's options. */
  options?: string[];
}

export interface TicketTypeInput {
  productId: string;
  name: string;
  fields: SupportField[];
}

export interface TicketType {
  id: string;
  name: string;
  fields: SupportField[];
}

/** Each product has one support type in Release 1; its id is fixed by the product. */
export const supportTypeId = (productId: string): string => `${productId}:support`;

function fieldErrors(fields: SupportField[]): string[] {
  return fields.flatMap((f, i) => {
    if (!f.label.trim()) return [`Field ${i + 1} needs a label.`];
    if (!FIELD_KINDS.includes(f.kind)) return [`Field "${f.label}" must be text or a choice list.`];
    if (f.kind === 'select' && !f.options?.length) return [`Field "${f.label}" is a choice list and needs at least one option.`];
    return [];
  });
}

/** Saves a product's support type and its extra fields. Throws SettingsError. */
export async function saveTicketType(db: D1Database, t: TicketTypeInput): Promise<void> {
  const errors = await missingProducts(db, [t.productId]);
  if (!t.name.trim()) errors.push('Name is required.');
  errors.push(...fieldErrors(t.fields));
  refuseIfAny(errors);
  await db
    .prepare(
      `INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, fields_json = excluded.fields_json`,
    )
    .bind(supportTypeId(t.productId), t.productId, 'support', t.name.trim(), JSON.stringify(t.fields), '[]', 1)
    .run();
}

export async function getTicketType(db: D1Database, productId: string): Promise<TicketType | null> {
  const row = await db
    .prepare("SELECT id, name, fields_json FROM ticket_types WHERE product_id = ? AND kind = 'support'")
    .bind(productId)
    .first<{ id: string; name: string; fields_json: string }>();
  return row ? { id: row.id, name: row.name, fields: JSON.parse(row.fields_json) as SupportField[] } : null;
}

export interface CannedInput {
  productId: string;
  /** The ticket type it is offered on, or null for every type of the product. */
  typeId: string | null;
  name: string;
  body: string;
}

export interface Canned {
  id: string;
  typeId: string | null;
  name: string;
  body: string;
}

/** Adds a canned reply and returns its id. Throws SettingsError. */
export async function saveCanned(db: D1Database, c: CannedInput): Promise<string> {
  const errors = await missingProducts(db, [c.productId]);
  if (!c.name.trim()) errors.push('Name is required.');
  if (!c.body.trim()) errors.push('Reply text is required.');
  if (c.typeId !== null && errors.length === 0) {
    const type = await db.prepare('SELECT id FROM ticket_types WHERE id = ? AND product_id = ?').bind(c.typeId, c.productId).first();
    if (!type) errors.push(`No such ticket type for this product: ${c.typeId}.`);
  }
  refuseIfAny(errors);
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO canned_replies (id, product_id, type_id, name, body) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.productId, c.typeId, c.name.trim(), c.body)
    .run();
  return id;
}

export async function listCanned(db: D1Database, productId: string): Promise<Canned[]> {
  const { results } = await db
    .prepare('SELECT id, type_id, name, body FROM canned_replies WHERE product_id = ? ORDER BY name')
    .bind(productId)
    .all<{ id: string; type_id: string | null; name: string; body: string }>();
  return results.map((r) => ({ id: r.id, typeId: r.type_id, name: r.name, body: r.body }));
}

/** Lowercase hex SHA-256 of an API key: all that is ever stored of it. */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** Makes a product API key: 32 random bytes, base64url. Returned once; only its hash is stored. */
export async function createApiKey(db: D1Database, productId: string, label: string, now = Date.now()): Promise<string> {
  const errors = await missingProducts(db, [productId]);
  if (!label.trim()) errors.push('Label is required.');
  refuseIfAny(errors);
  const key = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare('INSERT INTO api_keys (hash, product_id, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(await hashKey(key), productId, label.trim(), now)
    .run();
  return key;
}

export interface ApiKeySummary {
  hash: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
}

export async function listApiKeys(db: D1Database, productId: string): Promise<ApiKeySummary[]> {
  const { results } = await db
    .prepare('SELECT hash, label, created_at, revoked_at FROM api_keys WHERE product_id = ? ORDER BY created_at')
    .bind(productId)
    .all<{ hash: string; label: string; created_at: number; revoked_at: number | null }>();
  return results.map((r) => ({ hash: r.hash, label: r.label, createdAt: r.created_at, revokedAt: r.revoked_at }));
}

/** Revokes a key of this product; a key of another product is left alone. */
export async function revokeApiKey(db: D1Database, productId: string, hash: string, now = Date.now()): Promise<void> {
  await db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE hash = ? AND product_id = ? AND revoked_at IS NULL')
    .bind(now, hash, productId)
    .run();
}
