import { describe, expect, it } from 'vitest';
import {
  AppealNotFound,
  AppealRefused,
  appealStatus,
  appealTypeId,
  createAppeal,
  decideAppeal,
  findAppealable,
  parseAppeal,
  type Appealable,
} from '../../src/appeals/appeals.ts';
import type { Staff } from '../../src/auth/staff.ts';
import { hashKey } from '../../src/products.ts';
import type { Fetcher } from '../../src/punishments/send.ts';
import { standInDb } from './d1-stand-in.ts';

// One appeal per punishment, the admin's alone (shyden-labs/shydesk#61; Release 2
// plan Task 5). The appeal row's primary key is the punishment id, so a second
// appeal fails in the same batch as its ticket and nothing of it is kept. These
// stand-ins check what is asked and written; the SQL itself is proven on real D1
// in tests/integration/appeals.test.ts.

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const NOW = 1_762_600_000_000;
const REP: Staff = { email: 'rep@example.com', role: 'rep', products: ['shytalk'] };
const ADMIN: Staff = { email: 'admin@example.com', role: 'admin', products: ['shytalk', 'yawelo-idle'] };

const active: Appealable & Record<string, unknown> = {
  id: 'p1',
  product_id: 'shytalk',
  label: 'Ban 7 days',
  created_at: NOW - 1000,
  lifted_at: null,
  appealed: 0,
};

describe('appealTypeId', () => {
  it("is the product's id with :appeal", () => {
    expect(appealTypeId('shytalk')).toBe('shytalk:appeal');
  });
});

describe('findAppealable', () => {
  it('looks a token up by its hash within the product, with whether it was appealed', async () => {
    const { db, statements } = standInDb(() => [active]);
    expect(await findAppealable(db, 'shytalk', { token: 'tok' })).toEqual(active);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/LEFT JOIN appeals a ON a\.punishment_id = p\.id/);
    expect(statements[0]?.sql).toMatch(/WHERE p\.appeal_token_hash = \? AND p\.product_id = \?/);
    expect(statements[0]?.values).toEqual([await hashKey('tok'), 'shytalk']);
  });

  it('looks a punishment id up within the product', async () => {
    const { db, statements } = standInDb(() => [active]);
    expect(await findAppealable(db, 'shytalk', { punishmentId: 'p1' })).toEqual(active);
    expect(statements[0]?.sql).toMatch(/WHERE p\.id = \? AND p\.product_id = \?/);
    expect(statements[0]?.values).toEqual(['p1', 'shytalk']);
  });

  it('is null for an unknown token', async () => {
    const { db } = standInDb(() => []);
    expect(await findAppealable(db, 'shytalk', { token: 'nope' })).toBeNull();
  });

  it('asks nothing for an empty token or id', async () => {
    const { db, statements } = standInDb(() => [active]);
    expect(await findAppealable(db, 'shytalk', { token: '' })).toBeNull();
    expect(await findAppealable(db, 'shytalk', { punishmentId: '' })).toBeNull();
    expect(statements).toHaveLength(0);
  });
});

describe('appealStatus', () => {
  it('can be appealed while active and not yet appealed', () => {
    expect(appealStatus(active)).toEqual({ label: 'Ban 7 days', created_at: NOW - 1000, can_appeal: true });
  });

  it('is already_appealed once appealed, whatever the outcome', () => {
    expect(appealStatus({ ...active, appealed: 1 })).toEqual({
      label: 'Ban 7 days',
      created_at: NOW - 1000,
      can_appeal: false,
      reason: 'already_appealed',
    });
  });

  it('is lifted once lifted and not appealed', () => {
    expect(appealStatus({ ...active, lifted_at: NOW })).toMatchObject({ can_appeal: false, reason: 'lifted' });
  });

  it('says already_appealed for an upheld appeal, which also lifted it', () => {
    expect(appealStatus({ ...active, lifted_at: NOW, appealed: 1 })).toMatchObject({ reason: 'already_appealed' });
  });
});

describe('parseAppeal', () => {
  it('trims and lower-cases the email and trims the message', () => {
    expect(parseAppeal({ email: ' A@Example.COM ', message: '  Please look again.  ' })).toEqual({
      ok: true,
      value: { email: 'a@example.com', message: 'Please look again.' },
    });
  });

  it('names every field in error at once', () => {
    expect(parseAppeal({ email: 'nope', message: '' })).toEqual({
      ok: false,
      errors: { email: 'Enter a valid email address.', message: 'Enter a message.' },
    });
  });

  it('refuses a message over 10,000 characters and accepts one of exactly 10,000', () => {
    expect(parseAppeal({ email: 'a@b.co', message: 'x'.repeat(10_001) })).toEqual({
      ok: false,
      errors: { message: 'Keep the message to 10,000 characters.' },
    });
    expect(parseAppeal({ email: 'a@b.co', message: 'x'.repeat(10_000) }).ok).toBe(true);
  });

  it('refuses an email over 254 characters and accepts one of exactly 254', () => {
    expect(parseAppeal({ email: `${'a'.repeat(250)}@b.co`, message: 'm' })).toEqual({
      ok: false,
      errors: { email: 'Enter a valid email address.' },
    });
    expect(parseAppeal({ email: `${'a'.repeat(249)}@b.co`, message: 'm' }).ok).toBe(true);
  });

  it('cannot read a body that is not an object', () => {
    expect(parseAppeal(null)).toEqual({ ok: false, unreadable: true });
    expect(parseAppeal([])).toEqual({ ok: false, unreadable: true });
    expect(parseAppeal('x')).toEqual({ ok: false, unreadable: true });
  });
});

describe('createAppeal', () => {
  const input = { email: 'a@example.com', message: 'Please look again.' };

  it('writes the appeal type, the ticket, its message and the appeal row in one batch', async () => {
    const { db, statements } = standInDb();
    const made = await createAppeal(db, active, input, KEY, NOW);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const batch = statements.filter((s) => s.method === 'batch');
    expect(statements.every((s) => s.method === 'batch')).toBe(true);
    const sqls = batch.map((s) => s.sql);
    expect(sqls.some((s) => /^INSERT OR IGNORE INTO ticket_types/.test(s))).toBe(true);
    const type = batch.find((s) => /^INSERT OR IGNORE INTO ticket_types/.test(s.sql));
    expect(type?.values).toEqual(['shytalk:appeal', 'shytalk', 'appeal', 'Appeal', '[]', '[]', 1]);
    const ticket = batch.find((s) => /INSERT INTO tickets/.test(s.sql));
    expect(ticket?.values.slice(0, 6)).toEqual([made.id, 'shytalk', 'shytalk:appeal', 'a@example.com', 'Appeal: Ban 7 days', 'appeal']);
    expect(ticket?.values[6]).toBe(JSON.stringify({ punishment_id: 'p1' }));
    expect(ticket?.values[7]).toBe(await hashKey(made.token));
    const appeal = batch.find((s) => /^INSERT INTO appeals/.test(s.sql));
    expect(appeal?.sql).toMatch(/VALUES \(\?, \?, 'open'\)/);
    expect(appeal?.values).toEqual(['p1', made.id]);
    const message = batch.find((s) => /^INSERT INTO messages/.test(s.sql));
    expect(message?.values.slice(1)).toEqual([made.id, 'Please look again.', NOW]);
  });

  it('refuses an appealed punishment with already_appealed, writing nothing', async () => {
    const { db, statements } = standInDb();
    await expect(createAppeal(db, { ...active, appealed: 1 }, input, KEY, NOW)).rejects.toThrow(
      expect.objectContaining({ name: 'AppealRefused', code: 'already_appealed' }),
    );
    expect(statements).toHaveLength(0);
  });

  it('refuses a lifted punishment with lifted, writing nothing', async () => {
    const { db, statements } = standInDb();
    await expect(createAppeal(db, { ...active, lifted_at: NOW }, input, KEY, NOW)).rejects.toThrow(
      expect.objectContaining({ code: 'lifted' }),
    );
    expect(statements).toHaveLength(0);
  });

  it('turns the primary-key failure of a second appeal sent at the same moment into already_appealed', async () => {
    const { db } = standInDb();
    db.batch = () => Promise.reject(new Error('D1_ERROR: UNIQUE constraint failed: appeals.punishment_id: SQLITE_CONSTRAINT'));
    const refused = await createAppeal(db, active, input, KEY, NOW).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AppealRefused);
    expect((refused as AppealRefused).code).toBe('already_appealed');
  });

  it('lets any other write failure through unchanged', async () => {
    const { db } = standInDb();
    const failure = new Error('D1_ERROR: network');
    db.batch = () => Promise.reject(failure);
    await expect(createAppeal(db, active, input, KEY, NOW)).rejects.toBe(failure);
  });
});

describe('decideAppeal', () => {
  const open = { punishment_id: 'p1', ticket_id: 't1', state: 'open', product_id: 'shytalk', lifted_at: null };

  function setup(appeal: Record<string, unknown> | null = open, decidedFirst = false) {
    const { db, statements } = standInDb((sql, values) => {
      if (/FROM appeals a JOIN tickets t/.test(sql)) {
        const [id, ...scope] = values;
        return appeal && id === appeal.ticket_id && scope.includes(appeal.product_id) ? [appeal] : [];
      }
      if (/FROM punishments WHERE id = \?/.test(sql)) {
        return [{ id: 'p1', product_id: 'shytalk', lifted_at: appeal?.lifted_at ?? null, report_ticket_id: 'r1', send_state: 'applied' }];
      }
      if (/SELECT callback_url, callback_secret, appeal_page_url FROM products/.test(sql)) {
        return [{ callback_url: 'https://api.shytalk.example/punish', callback_secret: 'sec', appeal_page_url: null }];
      }
      if (/^UPDATE appeals/.test(sql)) return decidedFirst ? [] : [{ ticket_id: values[3] }];
      return [];
    });
    const types: unknown[] = [];
    const fetcher: Fetcher = (_url, init) => {
      types.push((JSON.parse(init.body as string) as { type: unknown }).type);
      return Promise.resolve(Response.json({ applied: true }));
    };
    return { env: { DB: db, TICKET_TOKEN_KEY: KEY }, statements, types, fetcher };
  }

  it('is not found for a rep, asking nothing', async () => {
    const { env, statements } = setup();
    await expect(decideAppeal(env, REP, 't1', 'upheld')).rejects.toBeInstanceOf(AppealNotFound);
    expect(statements).toHaveLength(0);
  });

  it('is not found for an appeal outside the admin products, or no appeal', async () => {
    const outside = setup({ ...open, product_id: 'other' });
    await expect(decideAppeal(outside.env, ADMIN, 't1', 'upheld')).rejects.toBeInstanceOf(AppealNotFound);
    const none = setup(null);
    await expect(decideAppeal(none.env, ADMIN, 't1', 'rejected')).rejects.toBeInstanceOf(AppealNotFound);
  });

  it('upheld records the decision and sends exactly one punishment.lift', async () => {
    const { env, statements, types, fetcher } = setup();
    expect(await decideAppeal(env, ADMIN, 't1', 'upheld', fetcher, NOW)).toBe('applied');
    expect(types).toEqual(['punishment.lift']);
    const decided = statements.find((s) => /^UPDATE appeals/.test(s.sql));
    expect(decided?.sql).toMatch(/WHERE ticket_id = \? AND state = 'open' RETURNING ticket_id/);
    expect(decided?.values).toEqual(['upheld', 'admin@example.com', NOW, 't1']);
  });

  it('rejected records the decision and sends nothing', async () => {
    const { env, statements, types, fetcher } = setup();
    expect(await decideAppeal(env, ADMIN, 't1', 'rejected', fetcher, NOW)).toBe('rejected');
    expect(types).toEqual([]);
    expect(statements.find((s) => /^UPDATE appeals/.test(s.sql))?.values).toEqual(['rejected', 'admin@example.com', NOW, 't1']);
    expect(statements.some((s) => /UPDATE punishments/.test(s.sql))).toBe(false);
  });

  it('upheld on a punishment the admin already lifted records the decision and sends nothing', async () => {
    const { env, types, statements, fetcher } = setup({ ...open, lifted_at: NOW - 5 });
    expect(await decideAppeal(env, ADMIN, 't1', 'upheld', fetcher, NOW)).toBe('upheld');
    expect(types).toEqual([]);
    expect(statements.some((s) => /^UPDATE appeals/.test(s.sql))).toBe(true);
  });

  it('refuses the second of two decisions made at the same moment, sending nothing', async () => {
    const { env, types, fetcher } = setup(open, true);
    await expect(decideAppeal(env, ADMIN, 't1', 'upheld', fetcher, NOW)).rejects.toThrow(
      expect.objectContaining({ code: 'already_decided' }),
    );
    expect(types).toEqual([]);
  });

  it('refuses an appeal already decided, changing nothing', async () => {
    const { env, statements, types, fetcher } = setup({ ...open, state: 'rejected' });
    await expect(decideAppeal(env, ADMIN, 't1', 'upheld', fetcher, NOW)).rejects.toThrow(
      expect.objectContaining({ name: 'AppealRefused', code: 'already_decided' }),
    );
    expect(types).toEqual([]);
    expect(statements.some((s) => /^UPDATE/.test(s.sql))).toBe(false);
  });
});
