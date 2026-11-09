import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The Worker's static assets hold the API docs (shyden-labs/shydesk#26). They
// are built before every deploy and dry run, and every request reaches the
// Worker first, so no asset is served before the staff check in src/api/docs.ts.
const text = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
const config = JSON.parse(
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1'),
) as {
  assets?: unknown;
  build?: unknown;
  durable_objects?: unknown;
  migrations?: unknown;
  vars?: unknown;
  env: { dev: { assets?: unknown; build?: unknown; durable_objects?: unknown; migrations?: unknown; vars?: unknown } };
};

describe('wrangler.jsonc', () => {
  it('serves the built docs as assets, through the Worker first, as ASSETS', () => {
    expect(config.assets).toEqual({ directory: './.assets', binding: 'ASSETS', run_worker_first: true });
  });

  it('builds the docs before every deploy', () => {
    expect(config.build).toEqual({ command: 'node scripts/build-api-docs.ts' });
  });

  it('lets dev inherit both, so dev and live serve the same docs the same way', () => {
    expect(config.env.dev.assets).toBeUndefined();
    expect(config.env.dev.build).toBeUndefined();
  });
});

// Each ticket's timer (shyden-labs/shydesk#22) is a SQLite-backed Durable
// Object, the kind the Workers Free plan allows. Bindings are not inherited by
// an environment, so dev names it too; migrations apply to both.
describe('the ticket timer in wrangler.jsonc', () => {
  const binding = { bindings: [{ name: 'TICKET_TIMER', class_name: 'TicketTimer' }] };

  it('binds TICKET_TIMER to TicketTimer on live and on dev', () => {
    expect(config.durable_objects).toEqual(binding);
    expect(config.env.dev.durable_objects).toEqual(binding);
  });

  it('creates TicketTimer as a SQLite-backed class, once, for both', () => {
    expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['TicketTimer'] }]);
    expect(config.env.dev.migrations).toBeUndefined();
  });

  it('is exported from the Worker entry point', async () => {
    const entry = await import('../../src/index.ts');
    const { TicketTimer } = await import('../../src/timers/ticket-timer.ts');
    expect(entry.TicketTimer).toBe(TicketTimer);
  });

  // shyden-labs/shydesk#19: Non-Prod checks the contact form with Cloudflare's
  // published always-pass test keys until shyden-labs/shydesk#13 sets real
  // ones; live never carries them, so it answers 503 until its secret is set.
  it('gives dev the Turnstile test keys and live none', () => {
    expect(config.env.dev.vars).toMatchObject({
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    });
    expect(config.vars).toBeUndefined();
  });

  // shyden-labs/shydesk#83: staff may try requests that write from the docs on Non-Prod only; live has no vars at all.
  it('lets the docs try writes on dev only', () => {
    expect(config.env.dev.vars).toMatchObject({ TRY_WRITES: 'true' });
    expect(config.vars).toBeUndefined();
  });

  // Staff sign in through Non-Prod's Cloudflare Access (shyden-labs/shydesk#74). Both values are
  // public: they appear in every Access login address and token, so they are vars, not secrets.
  it("gives dev Non-Prod's Access team and audience", () => {
    expect(config.env.dev.vars).toMatchObject({
      ACCESS_TEAM_DOMAIN: 'dawn-lab-ed42.cloudflareaccess.com',
      ACCESS_AUD: 'cecc27a55c169053120557c748cd105f9b4199f3a66d9ef313eaf5700db39973',
    });
  });
});
