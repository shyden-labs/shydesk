import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The demo support page (shyden-labs/shydesk#19) is its own static Worker on
// the Non-Prod account, and the dev deploy upserts its product into
// Non-Prod's D1, allowed only on the demo page's own origin.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const NON_PROD_SUBDOMAIN = 'shydesk-non-prod';

describe('the demo host', () => {
  // JSONC with comments: YAML reads it once the comment lines are dropped.
  const config = parse(read('demo-host/wrangler.jsonc').replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
  const origin = `https://${String(config.name)}.${NON_PROD_SUBDOMAIN}.workers.dev`;
  const seed = read('demo-host/seed.sql');

  it('is a static page on workers.dev with no Worker code', () => {
    expect(config).toEqual({
      $schema: '../node_modules/wrangler/config-schema.json',
      name: 'shydesk-demo',
      compatibility_date: expect.any(String) as unknown,
      workers_dev: true,
      assets: { directory: './public' },
    });
  });

  it("allows the demo product only on the demo page's own origin, and gives it a support type", () => {
    expect(seed).toContain(`'["${origin}"]'`);
    expect(seed).toContain(`'${origin}/support/ticket'`);
    expect(seed).toMatch(/INSERT INTO ticket_types[\s\S]*'demo:support', 'demo', 'support'/);
  });

  it('can run on every deploy, updating what is there', () => {
    expect(seed.match(/ON CONFLICT \(id\) DO UPDATE/g)).toHaveLength(2);
  });

  it('loads the piece from the Non-Prod ShyDesk for the demo product', () => {
    const page = read('demo-host/public/index.html');
    expect(page).toContain(`<script src="https://shydesk.${NON_PROD_SUBDOMAIN}.workers.dev/embed.js" defer></script>`);
    expect(page).toContain('<shydesk-support product="demo" view="contact" lang="en"></shydesk-support>');
  });
});
