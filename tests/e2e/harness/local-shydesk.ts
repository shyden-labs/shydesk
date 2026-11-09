/**
 * The local ShyDesk the e2e suite runs against (shyden-labs/shydesk#19):
 * this branch's Worker under `wrangler dev` with a local D1, so a pull
 * request tests its own code, not what Non-Prod last deployed. Its seed has
 * a demo product allowed only on the suite's origin and a second product
 * allowed only elsewhere, and the demo page (demo-host/public/index.html) is
 * served with its piece pointed at this ShyDesk.
 */
import { createHash } from 'node:crypto';

/** The ShyDesk the demo page loads the piece from when deployed. */
export const NON_PROD_SHYDESK = 'https://shydesk.shydesk-non-prod.workers.dev';
export const SHYDESK_PORT = 8787;

/** Cloudflare's published always-pass Turnstile test keys. */
/** The private link's token of the seeded ticket, whose one attachment has been removed. */
export const SEEDED_TICKET_TOKEN = 'e2e-seeded-ticket-token';

/** Encrypts only the local throwaway tickets of a test run. */
const TEST_TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

const PLAIN_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const PRODUCT_ID = /^[a-z0-9-]+$/;

/** The suite's own host on the ShyDesk port: localhost on desktop, the LAN address for the iPhone. */
export function shydeskOrigin(suiteOrigin: string): string {
  const url = new URL(suiteOrigin);
  url.port = String(SHYDESK_PORT);
  return url.origin;
}

/** The seed for the local D1, after the migrations. */
export function seedSql(suiteOrigin: string): string {
  if (!PLAIN_ORIGIN.test(suiteOrigin)) throw new Error(`${suiteOrigin} is not a plain origin`);
  const product = (id: string, name: string, origin: string) =>
    `INSERT INTO products (id, name, sender_address, ticket_page_url, allowed_origins_json, monthly_email_share, created_at) VALUES ` +
    `('${id}', '${name}', 'no-reply@example.com', '${origin}/support/ticket', '["${origin}"]', 100, 0);`;
  const fields = JSON.stringify([{ label: 'Device', kind: 'text', required: true }]);
  return [
    product('demo', 'Demo', suiteOrigin),
    product('demo-elsewhere', 'Elsewhere', 'https://elsewhere.example'),
    `INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES ('demo:support', 'demo', 'support', 'Support', '${fields}', '[]', 1);`,
    `INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES ('demo-elsewhere:support', 'demo-elsewhere', 'support', 'Support', '[]', '[]', 1);`,
    `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq) VALUES ('seeded', 'demo', 'demo:support', 'closed', 'e2e@example.com', 'Seeded', 'bug', '{}', '${createHash('sha256').update(SEEDED_TICKET_TOKEN).digest('hex')}', 0, 0, 0);`,
    `INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES ('seeded-message', 'seeded', 'customer', NULL, 'See the attached photo.', 0);`,
    `INSERT INTO attachments (id, product_id, ticket_id, message_id, r2_key, thumb_key, mime, bytes, state, created_at) VALUES ('seeded-photo', 'demo', 'seeded', 'seeded-message', 'gone', 'gone-thumb', 'image/jpeg', 1, 'deleted', 0);`,
  ].join('\n');
}

/** The demo page with its piece loaded from `shydesk` for `product`. */
export function demoPage(html: string, shydesk: string, product: string): string {
  if (!PRODUCT_ID.test(product)) throw new Error(`${product} is not a product id`);
  if (!html.includes(`${NON_PROD_SHYDESK}/embed.js`) || !html.includes('product="demo"')) {
    throw new Error('the demo page no longer loads the Non-Prod piece for product "demo"');
  }
  return html.replace(`${NON_PROD_SHYDESK}/embed.js`, `${shydesk}/embed.js`).replace('product="demo"', `product="${product}"`);
}

/** `npx` arguments for the local ShyDesk, its state kept in `stateDir`. */
export function wranglerDevArgs(stateDir: string): string[] {
  return [
    'wrangler',
    'dev',
    '--local',
    '--ip',
    '0.0.0.0',
    '--port',
    String(SHYDESK_PORT),
    '--persist-to',
    stateDir,
    '--var',
    `TURNSTILE_SITE_KEY:${TEST_SITE_KEY}`,
    '--var',
    `TURNSTILE_SECRET:${TEST_SECRET}`,
    '--var',
    `TICKET_TOKEN_KEY:${TEST_TOKEN_KEY}`,
  ];
}
