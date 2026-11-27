import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as entry from '../../src/index.ts';
import { TicketTimer } from '../../src/timers/ticket-timer.ts';

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
  observability?: unknown;
  vars?: Record<string, string>;
  routes?: unknown;
  workers_dev?: unknown;
  env: {
    dev: {
      assets?: unknown;
      build?: unknown;
      durable_objects?: unknown;
      migrations?: unknown;
      observability?: unknown;
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

  // shyden-labs/shydesk#218: Workers Logs stay on through every deploy. Wrangler
  // treats `observability` as inheritable, so dev takes live's block unchanged.
  it('keeps Workers Logs on for live and, by inheriting, for dev', () => {
    expect(config.observability).toEqual({ enabled: true });
    expect(config.env.dev.observability).toBeUndefined();
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

  // The Worker loads with the file, not inside this test, so its transform time does not
  // count against the test's 1 s (shyden-labs/shydesk#200).
  it('is exported from the Worker entry point', () => {
    expect(entry.TicketTimer).toBe(TicketTimer);
  });

  // shyden-labs/shydesk#13: live runs its account's real Turnstile widget. Dev runs Cloudflare's
  // always-pass test key (Shyden 2026-11-21, shyden-labs/shydesk#251), so CI journeys can send.
  // Site keys are public, so they are vars; TURNSTILE_SECRET is a Worker secret, so no config names one.
  it('gives live its real Turnstile site key, dev the always-pass test key, and neither a secret', () => {
    expect(config.vars).toMatchObject({ TURNSTILE_SITE_KEY: '0x4AAAAAAFzxpu4P-1-Vh2oT' });
    expect(config.env.dev.vars).toMatchObject({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA' });
    expect(config.vars).not.toHaveProperty('TURNSTILE_SECRET');
    expect(config.env.dev.vars).not.toHaveProperty('TURNSTILE_SECRET');
  });

  // shyden-labs/shydesk#13 AC3: both send through Sparked Host's mail server (Paris); the logins are the SMTP_LOGINS secret.
  // Bounces come back to dev's own domain; live gets one only at the release (shyden-labs/shydesk#232).
  it('dev sets BOUNCE_DOMAIN to shydeskdev.dpdns.org and live sets none', () => {
    expect(config.env.dev.vars).toMatchObject({ BOUNCE_DOMAIN: 'shydeskdev.dpdns.org' });
    expect(config.vars).not.toHaveProperty('BOUNCE_DOMAIN');
  });

  // shyden-labs/shydesk#254 AC3: only dev clears shyden.co.uk's journey test tickets by itself.
  it("dev names shyden.co.uk's test sender and live has no test-ticket setting", () => {
    expect(config.env.dev.vars).toMatchObject({ TEST_TICKET_PRODUCT: 'shyden-co-uk', TEST_TICKET_EMAIL: 'support-test+*@shyden.co.uk' });
    expect(config.vars).not.toHaveProperty('TEST_TICKET_PRODUCT');
    expect(config.vars).not.toHaveProperty('TEST_TICKET_EMAIL');
  });

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
  // shyden-labs/shydesk#302: the DEV door is on in dev alone; live (and so TEST) has no gate.
  it('dev gates on a DEV pass for its own host, with the sign-in key and the three embed origins', () => {
    expect(config.env.dev.vars).toMatchObject({
      DEV_PASS_HOST: 'shydesk.shydesk-non-prod.workers.dev',
      DEV_PASS_KEYS: '{"2026-11":"OBLprb_S4Kn2C--HFVaeA3_s6gEsApDiRAWPLc6WsK8"}',
      DEV_PASS_EMBED_ORIGINS: '["https://dev.yaweloidle.com","https://dev.shytalk.app","https://dev.shyden.co.uk"]',
    });
  });

  it('live sets no DEV door setting', () => {
    expect(Object.keys(config.vars as Record<string, string>).filter((name) => name.startsWith('DEV_PASS'))).toEqual([]);
  });
});
