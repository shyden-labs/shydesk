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
  vars?: Record<string, string>;
  routes?: unknown;
  workers_dev?: unknown;
  env: {
    dev: {
      assets?: unknown;
      build?: unknown;
      durable_objects?: unknown;
      migrations?: unknown;
      routes?: unknown;
      vars?: Record<string, string>;
    };
  };
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

  // shyden-labs/shydesk#13: each account's real Turnstile widget. Site keys are public, so they
  // are vars; each TURNSTILE_SECRET is a Worker secret Shyden sets, so no config names one.
  it('gives live and dev their own Turnstile site keys and no secret', () => {
    expect(config.vars).toMatchObject({ TURNSTILE_SITE_KEY: '0x4AAAAAAFzxpu4P-1-Vh2oT' });
    expect(config.env.dev.vars).toMatchObject({ TURNSTILE_SITE_KEY: '0x4AAAAAAFzxlFNTRFPriE2H' });
    expect(config.vars).not.toHaveProperty('TURNSTILE_SECRET');
    expect(config.env.dev.vars).not.toHaveProperty('TURNSTILE_SECRET');
  });

  // shyden-labs/shydesk#13 AC3: both send through Sparked Host's mail server (Paris); the logins are the SMTP_LOGINS secret.
  it('sends mail through Sparked Host on live and on dev', () => {
    expect(config.vars).toMatchObject({ SMTP_HOST: 'web-par-01.sparkedhost.us' });
    expect(config.env.dev.vars).toMatchObject({ SMTP_HOST: 'web-par-01.sparkedhost.us' });
  });

  // shyden-labs/shydesk#13 AC1: live staff sign in through the live account's Access app "ShyDesk staff"
  // over shydesk.dpdns.org /desk, /admin and /api/docs (created 2026-11-11). Both values are public.
  it("gives live the live account's Access team and audience", () => {
    expect(config.vars).toMatchObject({
      ACCESS_TEAM_DOMAIN: 'mute-hall-8342.cloudflareaccess.com',
      ACCESS_AUD: '7348351af5ffa113214ae16277b0d288153984854337eb2cade7cf4d18bd1ea0',
    });
  });

  // shyden-labs/shydesk#13 AC2: live is served on its own domain, never on workers.dev.
  it('serves live on shydesk.dpdns.org as a custom domain', () => {
    expect(config.routes).toEqual([{ pattern: 'shydesk.dpdns.org', custom_domain: true }]);
    expect(config.workers_dev).toBe(false);
  });

  // Routes are inherited by an environment: without its own empty list, a dev deploy would claim live's domain.
  it('keeps dev off the live domain', () => {
    expect(config.env.dev.routes).toEqual([]);
  });

  // shyden-labs/shydesk#83: staff may try requests that write from the docs on Non-Prod only.
  it('lets the docs try writes on dev only', () => {
    expect(config.env.dev.vars).toMatchObject({ TRY_WRITES: 'true' });
    expect(config.vars).not.toHaveProperty('TRY_WRITES');
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
