import { describe, expect, it } from 'vitest';
import { hashKey } from '../../src/products.ts';
import {
  demoPage,
  seedSql,
  shydeskOrigin,
  wranglerDevArgs,
  NON_PROD_SHYDESK,
  SEEDED_TICKET_TOKEN,
} from '../../tests/e2e/harness/local-shydesk.ts';

// The e2e suite runs this branch's ShyDesk locally (shyden-labs/shydesk#19):
// a demo product allowed on the suite's own origin, one allowed only
// elsewhere, and the demo page pointed at the local ShyDesk.
describe('shydeskOrigin', () => {
  it('is the suite origin host on port 8787', () => {
    expect(shydeskOrigin('http://localhost:8765')).toBe('http://localhost:8787');
    expect(shydeskOrigin('http://192.168.1.7:8765')).toBe('http://192.168.1.7:8787');
  });
});

describe('seedSql', () => {
  const sql = seedSql('http://localhost:8765');

  it('seeds a rep on both products and a canned reply with placeholders', () => {
    expect(sql).toContain("INSERT INTO staff (email, role, created_at) VALUES ('e2e-rep@example.com', 'rep', 0)");
    expect(sql).toContain("('e2e-rep@example.com', 'demo'), ('e2e-rep@example.com', 'demo-elsewhere')");
    expect(sql).toContain('Hello {{customer_email}}, about {{ticket_subject}}.');
  });

  it('seeds a ticket found by its token, holding a removed attachment', async () => {
    expect(sql).toContain(`'${await hashKey(SEEDED_TICKET_TOKEN)}'`);
    expect(sql).toMatch(/INSERT INTO attachments[^;]*'deleted'/);
    expect(sql).not.toContain(SEEDED_TICKET_TOKEN);
  });

  it('allows the demo product only on the suite origin, with its ticket page there', () => {
    expect(sql).toContain(`('demo', 'Demo', 'no-reply@example.com', 'http://localhost:8765/support/ticket', '["http://localhost:8765"]'`);
  });

  // shyden-labs/shydesk#78: the contact form only shows once both privacy policy links are set.
  it('gives each product its English and Indonesian privacy policy links', () => {
    expect(sql).toContain("100, 'http://localhost:8765/privacy-en.html', 'http://localhost:8765/privacy-id.html', 0);");
    expect(sql).toContain("100, 'https://elsewhere.example/privacy-en.html', 'https://elsewhere.example/privacy-id.html', 0);");
  });

  it('allows the second product only somewhere else', () => {
    expect(sql).toContain(
      `('demo-elsewhere', 'Elsewhere', 'no-reply@example.com', 'https://elsewhere.example/support/ticket', '["https://elsewhere.example"]'`,
    );
  });

  it('gives the demo product a support type with a required Device field', () => {
    expect(sql).toContain(`('demo:support', 'demo', 'support', 'Support', '[{"label":"Device","kind":"text","required":true}]', '[]', 1)`);
  });

  it('refuses an origin that would break out of the SQL', () => {
    expect(() => seedSql("http://x'; DROP TABLE products; --")).toThrow('not a plain origin');
  });
});

describe('demoPage', () => {
  const html = `<script src="${NON_PROD_SHYDESK}/embed.js" defer></script>\n<shydesk-support product="demo" view="contact" lang="en"></shydesk-support>`;

  it('loads the piece from the local ShyDesk for the product asked for', () => {
    expect(demoPage(html, 'http://localhost:8787', 'demo-elsewhere')).toBe(
      `<script src="http://localhost:8787/embed.js" defer></script>\n<shydesk-support product="demo-elsewhere" view="contact" lang="en"></shydesk-support>`,
    );
  });

  it('refuses a product id that is not plain', () => {
    expect(() => demoPage(html, 'http://localhost:8787', '"><script>')).toThrow('not a product id');
  });

  it('fails when the page no longer loads the Non-Prod piece', () => {
    expect(() => demoPage('<p>moved</p>', 'http://localhost:8787', 'demo')).toThrow('demo page no longer loads');
  });
});

describe('wranglerDevArgs', () => {
  it('runs locally on every address on 8787 with the Turnstile always-pass test keys and its own state folder', () => {
    expect(wranglerDevArgs('/runs/state', '{"keys":[]}')).toEqual([
      'wrangler',
      'dev',
      'tests/e2e/harness/worker.ts',
      '--local',
      '--ip',
      '0.0.0.0',
      '--port',
      '8787',
      '--persist-to',
      '/runs/state',
      '--var',
      'TURNSTILE_SITE_KEY:1x00000000000000000000AA',
      '--var',
      'TURNSTILE_SECRET:1x0000000000000000000000000000000AA',
      '--var',
      `TICKET_TOKEN_KEY:${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`,
      '--var',
      'ACCESS_TEAM_DOMAIN:shydesk-e2e.example',
      '--var',
      'ACCESS_AUD:shydesk-e2e',
      '--var',
      'FIRST_ADMIN_EMAIL:e2e-admin@example.com',
      '--var',
      'E2E_ACCESS_JWKS:{"keys":[]}',
    ]);
  });
});
