import { describe, expect, it } from 'vitest';
import type { Staff } from '../../src/auth/staff.ts';
import { hashKey } from '../../src/products.ts';
import {
  PunishmentNotFound,
  PunishmentRefused,
  appealToken,
  applyPunishment,
  liftPunishment,
  resendPunishment,
} from '../../src/punishments/apply.ts';
import type { Fetcher } from '../../src/punishments/send.ts';
import { standInDb, type Statement } from './d1-stand-in.ts';

// Applying, re-sending and lifting a punishment (shyden-labs/shydesk#60 AC2, AC3).
// A rep acts only on reports of their products; another product's report is 404.
// Only the admin lifts. "Send again" re-sends the same punishment id and the same
// appeal link: the link's token is derived from the punishment id with the
// ticket-link key, and only its hash is stored.

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const NOW = 1_762_500_000_000;
const REP: Staff = { email: 'rep@example.com', role: 'rep', products: ['shytalk'] };
const ADMIN: Staff = { email: 'admin@example.com', role: 'admin', products: ['shytalk', 'yawelo-idle'] };
const BAN = { key: 'ban-7d', label: 'Ban 7 days', duration_seconds: 604800 };

interface World {
  /** Stored punishments, by id, as the scoped lookup returns them. */
  punishments?: Record<string, Record<string, unknown>>;
  appealPage?: string | null;
}

function setup(w: World = {}) {
  const { db, statements } = standInDb((sql, values) => {
    if (/FROM tickets t JOIN reports r/.test(sql)) {
      const [id, ...scope] = values;
      return id === 'r1' && scope.includes('shytalk') ? [{ id: 'r1', product_id: 'shytalk', subject_user_id: 'user-2' }] : [];
    }
    if (/SELECT punishments_json FROM products/.test(sql)) return [{ punishments_json: JSON.stringify([BAN]) }];
    if (/SELECT callback_url, callback_secret, appeal_page_url FROM products/.test(sql)) {
      return [{ callback_url: 'https://api.shytalk.example/punish', callback_secret: 'sec', appeal_page_url: w.appealPage ?? null }];
    }
    if (/FROM punishments WHERE id = \?/.test(sql)) {
      const [id, ...scope] = values;
      const row = w.punishments?.[String(id)];
      return row && scope.includes(row.product_id) ? [row] : [];
    }
    return [];
  });
  const bodies: Record<string, unknown>[] = [];
  const fetcher: Fetcher = (_url, init) => {
    bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return Promise.resolve(Response.json({ applied: true }));
  };
  return { env: { DB: db, TICKET_TOKEN_KEY: KEY }, db, statements, bodies, fetcher };
}

const inserts = (statements: Statement[]) => statements.filter((s) => /^INSERT INTO punishments/.test(s.sql));
const writes = (statements: Statement[]) => statements.filter((s) => /^(INSERT|UPDATE)/.test(s.sql));

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'pun-1',
  product_id: 'shytalk',
  report_ticket_id: 'r1',
  subject_user_id: 'user-2',
  punishment_key: 'ban-7d',
  label: 'Ban 7 days',
  duration_seconds: 604800,
  applied_by: 'rep@example.com',
  created_at: NOW,
  send_state: 'failed',
  send_error: 'timeout',
  appeal_token_hash: 'h',
  lifted_at: null,
  lifted_by: null,
  lift_state: null,
  lift_error: null,
  ...over,
});

describe('appealToken', () => {
  it('is the same for one punishment every time and different for another', async () => {
    const one = await appealToken(KEY, 'pun-1');
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(appealToken(KEY, 'pun-1')).resolves.toBe(one);
    await expect(appealToken(KEY, 'pun-2')).resolves.not.toBe(one);
  });
});

describe('applyPunishment', () => {
  it("records the product's punishment as sending, then sends it once", async () => {
    const { env, statements, bodies, fetcher } = setup();
    const row = await applyPunishment(env, REP, 'r1', 'ban-7d', fetcher, NOW);
    const insert = inserts(statements)[0];
    expect(insert?.values).toEqual([
      row.id,
      'shytalk',
      'r1',
      'user-2',
      'ban-7d',
      'Ban 7 days',
      604800,
      'rep@example.com',
      NOW,
      'sending',
      await hashKey(await appealToken(KEY, row.id)),
    ]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.punishment_id).toBe(row.id);
    expect(row.send_state).toBe('applied');
  });

  it('sends the appeal link with the token in the fragment when the product has an appeal page', async () => {
    const { env, bodies, fetcher } = setup({ appealPage: 'https://shytalk.example/appeal' });
    const row = await applyPunishment(env, REP, 'r1', 'ban-7d', fetcher, NOW);
    expect(bodies[0]?.appeal_url).toBe(`https://shytalk.example/appeal#appeal=${await appealToken(KEY, row.id)}`);
  });

  it('sends no appeal link when the product has no appeal page', async () => {
    const { env, bodies, fetcher } = setup({ appealPage: null });
    await applyPunishment(env, REP, 'r1', 'ban-7d', fetcher, NOW);
    expect(bodies[0]).not.toHaveProperty('appeal_url');
  });

  it("refuses a rep out of scope on another product's report as not found, writing and sending nothing", async () => {
    const { env, statements, bodies, fetcher } = setup();
    const outside: Staff = { ...REP, products: ['yawelo-idle'] };
    await expect(applyPunishment(env, outside, 'r1', 'ban-7d', fetcher, NOW)).rejects.toBeInstanceOf(PunishmentNotFound);
    expect(writes(statements)).toEqual([]);
    expect(bodies).toEqual([]);
  });

  it('refuses a punishment the product does not list', async () => {
    const { env, statements, fetcher } = setup();
    await expect(applyPunishment(env, REP, 'r1', 'ban-forever', fetcher, NOW)).rejects.toMatchObject({ code: 'unknown_punishment' });
    expect(writes(statements)).toEqual([]);
  });

  it('refuses when the ticket-link key is not set, since the appeal link cannot be made', async () => {
    const { db, statements, fetcher } = setup();
    const refusing = applyPunishment({ DB: db }, REP, 'r1', 'ban-7d', fetcher, NOW);
    await expect(refusing).rejects.toBeInstanceOf(PunishmentRefused);
    await expect(refusing).rejects.toMatchObject({ code: 'no_token_key' });
    expect(writes(statements)).toEqual([]);
  });
});

describe('resendPunishment', () => {
  it('re-sends a failed punishment with the same punishment id and the same appeal link', async () => {
    const { env, statements, bodies, fetcher } = setup({
      punishments: { 'pun-1': stored() },
      appealPage: 'https://shytalk.example/appeal',
    });
    await resendPunishment(env, REP, 'pun-1', fetcher, NOW);
    expect(statements.find((s) => /SET send_state = 'sending'/.test(s.sql))?.values).toEqual(['pun-1']);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.punishment_id).toBe('pun-1');
    expect(bodies[0]?.appeal_url).toBe(`https://shytalk.example/appeal#appeal=${await appealToken(KEY, 'pun-1')}`);
  });

  it('never re-sends the apply of a punishment the admin has lifted, for anyone', async () => {
    const lifted = stored({ lifted_at: NOW, lifted_by: 'admin@example.com', lift_state: 'applied', lift_error: null });
    for (const who of [REP, ADMIN]) {
      const { env, statements, bodies, fetcher } = setup({ punishments: { 'pun-1': lifted } });
      await expect(resendPunishment(env, who, 'pun-1', fetcher, NOW)).rejects.toMatchObject({ code: 'already_lifted' });
      expect(writes(statements)).toEqual([]);
      expect(bodies).toEqual([]);
    }
  });

  it('sends nothing for a punishment that did not fail', async () => {
    const { env, bodies, fetcher } = setup({ punishments: { 'pun-1': stored({ send_state: 'applied', send_error: null }) } });
    await expect(resendPunishment(env, REP, 'pun-1', fetcher, NOW)).rejects.toMatchObject({ code: 'nothing_to_send' });
    expect(bodies).toEqual([]);
  });

  it("is not found for another product's punishment", async () => {
    const { env, fetcher } = setup({ punishments: { 'pun-1': stored({ product_id: 'yawelo-idle' }) } });
    await expect(resendPunishment(env, REP, 'pun-1', fetcher, NOW)).rejects.toBeInstanceOf(PunishmentNotFound);
  });

  it('re-sends a failed lift for the admin, and is not found for a rep', async () => {
    const lifted = stored({
      send_state: 'applied',
      send_error: null,
      lifted_at: NOW,
      lifted_by: 'admin@example.com',
      lift_state: 'failed',
      lift_error: 'timeout',
    });
    const rep = setup({ punishments: { 'pun-1': lifted } });
    await expect(resendPunishment(rep.env, REP, 'pun-1', rep.fetcher, NOW)).rejects.toBeInstanceOf(PunishmentNotFound);
    expect(rep.bodies).toEqual([]);
    const admin = setup({ punishments: { 'pun-1': lifted } });
    await resendPunishment(admin.env, ADMIN, 'pun-1', admin.fetcher, NOW);
    expect(admin.statements.find((s) => /SET lift_state = 'sending'/.test(s.sql))?.values).toEqual(['pun-1']);
    expect(admin.bodies[0]?.type).toBe('punishment.lift');
  });
});

describe('liftPunishment', () => {
  it('lets the admin lift, recording who and when, then sends the lift once', async () => {
    const { env, statements, bodies, fetcher } = setup({ punishments: { 'pun-1': stored({ send_state: 'applied', send_error: null }) } });
    await liftPunishment(env, ADMIN, 'pun-1', fetcher, NOW);
    const lift = statements.find((s) => /SET lifted_at = \?, lifted_by = \?, lift_state = 'sending'/.test(s.sql));
    expect(lift?.sql).toMatch(/WHERE id = \? AND lifted_at IS NULL/);
    expect(lift?.values).toEqual([NOW, 'admin@example.com', 'pun-1']);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.type).toBe('punishment.lift');
  });

  it('is not found for a rep, even in scope, writing and sending nothing', async () => {
    const { env, statements, bodies, fetcher } = setup({ punishments: { 'pun-1': stored({ send_state: 'applied', send_error: null }) } });
    await expect(liftPunishment(env, REP, 'pun-1', fetcher, NOW)).rejects.toBeInstanceOf(PunishmentNotFound);
    expect(writes(statements)).toEqual([]);
    expect(bodies).toEqual([]);
  });

  it('refuses a punishment already lifted', async () => {
    const { env, bodies, fetcher } = setup({
      punishments: { 'pun-1': stored({ send_state: 'applied', lifted_at: 1, lift_state: 'applied' }) },
    });
    await expect(liftPunishment(env, ADMIN, 'pun-1', fetcher, NOW)).rejects.toMatchObject({ code: 'already_lifted' });
    expect(bodies).toEqual([]);
  });

  it('is not found for a punishment that does not exist', async () => {
    const { env, fetcher } = setup();
    await expect(liftPunishment(env, ADMIN, 'nope', fetcher, NOW)).rejects.toBeInstanceOf(PunishmentNotFound);
  });
});

describe('edges (shyden-labs/shydesk#60)', () => {
  const NOBODY: Staff = { email: 'new@example.com', role: 'rep', products: [] };

  it('finds nothing for a rep with no products, asking the database nothing', async () => {
    const { env, statements, fetcher } = setup({ punishments: { 'pun-1': stored() } });
    await expect(applyPunishment(env, NOBODY, 'r1', 'ban-7d', fetcher, NOW)).rejects.toBeInstanceOf(PunishmentNotFound);
    await expect(resendPunishment(env, NOBODY, 'pun-1', fetcher, NOW)).rejects.toBeInstanceOf(PunishmentNotFound);
    expect(statements).toEqual([]);
  });

  it('records no_callback when the product row cannot be read', async () => {
    const { db, statements } = standInDb((sql) => {
      if (/FROM tickets t JOIN reports r/.test(sql)) return [{ id: 'r1', product_id: 'shytalk', subject_user_id: 'user-2' }];
      if (/SELECT punishments_json FROM products/.test(sql)) return [{ punishments_json: JSON.stringify([BAN]) }];
      return [];
    });
    const bodies: unknown[] = [];
    const fetcher: Fetcher = (_url, init) => {
      bodies.push(init.body);
      return Promise.resolve(Response.json({ applied: true }));
    };
    const row = await applyPunishment({ DB: db, TICKET_TOKEN_KEY: KEY }, REP, 'r1', 'ban-7d', fetcher, NOW);
    expect(row.send_state).toBe('failed');
    expect(statements.find((s) => /UPDATE punishments SET send_state/.test(s.sql))?.values).toEqual(['failed', 'no_callback', row.id]);
    expect(bodies).toEqual([]);
  });
});
