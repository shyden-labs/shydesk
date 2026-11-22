/**
 * The local ShyDesk the e2e suite runs against (shyden-labs/shydesk#19):
 * this branch's Worker under `wrangler dev` with a local D1, so a pull
 * request tests its own code, not what Non-Prod last deployed. Its seed has
 * a demo product allowed only on the suite's origin and a second product
 * allowed only elsewhere, and the demo page (demo-host/public/index.html) is
 * served with its piece pointed at this ShyDesk.
 */
import { createHash } from 'node:crypto';
import { TARGETS, type Target } from './targets.ts';

/** The ShyDesk the demo page loads the piece from when deployed. */
export const NON_PROD_SHYDESK = 'https://shydesk.shydesk-non-prod.workers.dev';
export const SHYDESK_PORT = 8787;

/** Cloudflare's published always-pass Turnstile test keys. */
/** The rep the suite signs in as, granted both seeded products. */
export const E2E_REP = 'e2e-rep@example.com';
export const E2E_ACCESS_TEAM = 'shydesk-e2e.example';
export const E2E_ACCESS_AUD = 'shydesk-e2e';

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

/** The ban notice token of the seeded punishment `target` appeals (shyden-labs/shydesk#61): one each, as all share one ShyDesk. */
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const seededAppealToken = (target: Target): string => `e2e-appeal-${target}`;

/** The seed for the local D1, after the migrations; the demo product is also allowed on `otherOrigins`. */
export function seedSql(suiteOrigin: string, otherOrigins: readonly string[] = []): string {
  const allowed = [...new Set([suiteOrigin, ...otherOrigins])];
  for (const origin of allowed) if (!PLAIN_ORIGIN.test(origin)) throw new Error(`${origin} is not a plain origin`);
  const product = (id: string, name: string, origins: readonly string[], testOrigins: readonly string[] = [], page = '/support/ticket') =>
    `INSERT INTO products (id, name, sender_address, ticket_page_url, allowed_origins_json, test_origins_json, monthly_email_share, created_at) VALUES ` +
    `('${id}', '${name}', 'no-reply@example.com', '${origins[0] ?? ''}${page}', '${JSON.stringify(origins)}', '${JSON.stringify(testOrigins)}', 100, 0);`;
  const fields = JSON.stringify([{ label: 'Device', kind: 'text', required: true }]);
  return [
    product('demo', 'Demo', allowed),
    product('demo-elsewhere', 'Elsewhere', ['https://elsewhere.example']),
    // Its TEST site is the suite, its live site elsewhere (shyden-labs/shydesk#263).
    // Its ticket page names it, as the suite's ticket page shows the product its query asks for.
    product('demo-test', 'Demo Test', ['https://live.demo-test.example'], allowed, '/support/ticket?product=demo-test'),
    `INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES ('demo:support', 'demo', 'support', 'Support', '${fields}', '[]', 1);`,
    `INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES ('demo-elsewhere:support', 'demo-elsewhere', 'support', 'Support', '[]', '[]', 1);`,
    `INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES ('demo-test:support', 'demo-test', 'support', 'Support', '[]', '[]', 1);`,
    `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq) VALUES ('seeded', 'demo', 'demo:support', 'closed', 'e2e@example.com', 'Seeded', 'bug', '{}', '${sha256(SEEDED_TICKET_TOKEN)}', 0, 0, 0);`,
    `INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES ('seeded-message', 'seeded', 'customer', NULL, 'See the attached photo.', 0);`,
    `INSERT INTO attachments (id, product_id, ticket_id, message_id, r2_key, thumb_key, mime, bytes, state, created_at) VALUES ('seeded-photo', 'demo', 'seeded', 'seeded-message', 'gone', 'gone-thumb', 'image/jpeg', 1, 'deleted', 0);`,
    `INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled) VALUES ('demo:report', 'demo', 'report', 'Report', '[]', '["Cheating"]', 1);`,
    `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq) VALUES ('seeded-report', 'demo', 'demo:report', 'closed', '', 'Cheating: player p-2', 'Cheating', '{}', '${sha256('e2e-unused-report-token')}', 0, 0, 0);`,
    ...TARGETS.map(
      (target) =>
        `INSERT INTO punishments (id, product_id, report_ticket_id, subject_user_id, punishment_key, label, duration_seconds, applied_by, created_at, send_state, appeal_token_hash) VALUES ('seeded-ban-${target}', 'demo', 'seeded-report', 'p-2', 'ban-7d', 'Ban 7 days', 604800, '${E2E_REP}', 0, 'applied', '${sha256(seededAppealToken(target))}');`,
    ),
    `INSERT INTO staff (email, role, created_at) VALUES ('${E2E_REP}', 'rep', 0);`,
    `INSERT INTO staff_products (email, product_id) VALUES ('${E2E_REP}', 'demo'), ('${E2E_REP}', 'demo-elsewhere'), ('${E2E_REP}', 'demo-test');`,
    `INSERT INTO canned_replies (id, product_id, type_id, name, body) VALUES ('thanks', 'demo', NULL, 'Thanks', 'Hello {{customer_email}}, about {{ticket_subject}}.');`,
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

/**
 * The page's style policy (shyden-labs/shydesk#266): its own <style> blocks by hash and nothing
 * else inline, so a piece that needs style-src 'unsafe-inline' draws unstyled and the journey's
 * size checks fail.
 */
export function pageStylePolicy(html: string): string {
  const hashes = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    ([, css = '']) => `'sha256-${createHash('sha256').update(css).digest('base64')}'`,
  );
  return ["style-src 'self'", ...hashes].join(' ');
}

/** `npx` arguments for the local ShyDesk, its state kept in `stateDir`. */
export function wranglerDevArgs(stateDir: string, accessKeys: string): string[] {
  return [
    'wrangler',
    'dev',
    'tests/e2e/harness/worker.ts',
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
    '--var',
    `ACCESS_TEAM_DOMAIN:${E2E_ACCESS_TEAM}`,
    '--var',
    `ACCESS_AUD:${E2E_ACCESS_AUD}`,
    '--var',
    'FIRST_ADMIN_EMAIL:e2e-admin@example.com',
    '--var',
    `E2E_ACCESS_JWKS:${accessKeys}`,
  ];
}
