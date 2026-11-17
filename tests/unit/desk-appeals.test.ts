import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { deskRoutes, type DeskBindings } from '../../src/desk/routes.ts';
import type { Fetcher } from '../../src/punishments/send.ts';
import { standInDb } from './d1-stand-in.ts';

// Appeals on the staff desk (shyden-labs/shydesk#61; Release 2 plan Task 5): only
// the admin sees an appeal ticket, with the punishment it is about and buttons to
// uphold or reject it while it is open. Upheld lifts the punishment and sends one
// punishment.lift; rejected sends nothing. A rep is told nothing: 404 everywhere.

const TEAM = 'shydesk-test.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-desk';
const ADMIN = 'admin@example.com';
const REP = 'rep@example.com';
const ORIGIN = 'http://localhost';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let jwks: JWTVerifyGetKey;
let sign: (email: string) => Promise<string>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
  sign = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setAudience(AUD)
      .setIssuer(`https://${TEAM}`)
      .setExpirationTime('5m')
      .sign(pair.privateKey);
});

const APPEAL_TICKET = {
  id: 'ap1',
  product_id: 'shytalk',
  type_id: 'shytalk:appeal',
  status: 'open',
  customer_email: 'a@example.com',
  subject: 'Appeal: Ban 7 days',
  category: 'appeal',
  fields_json: '{"punishment_id":"pun-1"}',
  created_at: 5,
  updated_at: 6,
  seq: 3,
  token_sealed: null,
  text_deleted_at: null,
};

interface Appeal {
  state: string;
  decided_by: string | null;
  decided_at: number | null;
  lifted_at: number | null;
}

function setup(appeal: Appeal = { state: 'open', decided_by: null, decided_at: null, lifted_at: null }, updateFails = false) {
  const { db, statements } = standInDb((sql, values) => {
    if (updateFails && /^UPDATE appeals/.test(sql)) throw new Error('D1 is down');
    if (/FROM staff_products/.test(sql)) return values[0] === REP ? [{ product_id: 'shytalk' }] : [];
    if (/FROM staff WHERE/.test(sql)) return values[0] === REP ? [{ role: 'rep' }] : [];
    if (/SELECT id FROM products ORDER BY id/.test(sql)) return [{ id: 'shytalk' }, { id: 'yawelo-idle' }];
    if (/SELECT callback_url, callback_secret, appeal_page_url FROM products/.test(sql)) {
      return [{ callback_url: 'https://api.shytalk.example/punish', callback_secret: 'sec', appeal_page_url: null }];
    }
    // As the SQL does: a rep's lookup leaves appeal tickets out.
    if (/FROM tickets WHERE id = \? AND product_id IN/.test(sql))
      return values[0] === 'ap1' && values.slice(1).includes('shytalk') && !sql.includes("kind != 'appeal'") ? [APPEAL_TICKET] : [];
    if (/FROM appeals a JOIN tickets t/.test(sql))
      return values[0] === 'ap1' && values.slice(1).includes('shytalk')
        ? [{ punishment_id: 'pun-1', ticket_id: 'ap1', state: appeal.state, product_id: 'shytalk', lifted_at: appeal.lifted_at }]
        : [];
    if (/FROM appeals a JOIN punishments p/.test(sql))
      return values[0] === 'ap1' ? [{ ...appeal, punishment_id: 'pun-1', label: 'Ban <7> days', report_ticket_id: 'r1' }] : [];
    if (/^UPDATE appeals/.test(sql)) return appeal.state === 'open' ? [{ ticket_id: values[3] }] : [];
    if (/FROM punishments WHERE id = \?/.test(sql))
      return [{ id: 'pun-1', product_id: 'shytalk', report_ticket_id: 'r1', label: 'Ban 7 days', lifted_at: appeal.lifted_at }];
    if (/FROM messages/.test(sql)) return [{ id: 'm1', author: 'customer', staff_email: null, body: 'Please look again.', created_at: 5 }];
    return [];
  });
  const sent: Record<string, unknown>[] = [];
  const fetcher: Fetcher = (_url, init) => {
    sent.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return Promise.resolve(Response.json({ applied: true }));
  };
  const env = {
    DB: db,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    FIRST_ADMIN_EMAIL: ADMIN,
    TICKET_TOKEN_KEY: KEY,
  } as unknown as DeskBindings;
  const app = deskRoutes({ deliver: () => Promise.resolve(), fetcher }, jwks);
  const get = async (path: string, who = ADMIN) =>
    app.request(path, { headers: { 'Cf-Access-Jwt-Assertion': await sign(who), Origin: ORIGIN } }, env);
  const post = async (path: string, form: Record<string, string> = {}, who = ADMIN) =>
    app.request(
      path,
      {
        method: 'POST',
        body: new URLSearchParams(form),
        headers: { 'Cf-Access-Jwt-Assertion': await sign(who), 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
      },
      env,
    );
  return { get, post, statements, sent };
}

describe('an appeal ticket on the desk', () => {
  it('shows the admin the punishment appealed, escaped, with a link to its report and buttons to uphold or reject', async () => {
    const page = await (await setup().get('/desk/tickets/ap1')).text();
    expect.soft(page).toContain('<section aria-label="Appeal">');
    expect.soft(page).toContain('Appeal of Ban &lt;7&gt; days');
    expect.soft(page).toContain('href="/desk/tickets/r1"');
    expect.soft(page).toContain('Waiting for a decision.');
    expect.soft(page).toContain('action="/desk/tickets/ap1/appeal"');
    expect.soft(page).toContain('<button type="submit" name="outcome" value="upheld">Uphold and lift</button>');
    expect.soft(page).toContain('<button type="submit" name="outcome" value="rejected">Reject</button>');
    expect.soft(page).toContain('Please look again.');
  });

  it('shows a decided appeal with who decided and when, and no buttons', async () => {
    const page = await (
      await setup({ state: 'rejected', decided_by: ADMIN, decided_at: 1_762_600_000_000, lifted_at: null }).get('/desk/tickets/ap1')
    ).text();
    expect.soft(page).toContain('Rejected by admin@example.com, 2025-11-08 11:06.');
    expect.soft(page).not.toContain('name="outcome"');
  });

  it('shows an upheld appeal as upheld', async () => {
    const page = await (
      await setup({ state: 'upheld', decided_by: ADMIN, decided_at: 1_762_600_000_000, lifted_at: 1 }).get('/desk/tickets/ap1')
    ).text();
    expect(page).toContain('Upheld by admin@example.com, 2025-11-08 11:06.');
  });

  it('shows an appeal in a state it does not know as it is', async () => {
    const page = await (await setup({ state: 'odd', decided_by: null, decided_at: null, lifted_at: null }).get('/desk/tickets/ap1')).text();
    expect(page).toContain('<p>odd by , .</p>');
  });

  it('is 404 for a rep, even in the product', async () => {
    const response = await setup().get('/desk/tickets/ap1', REP);
    expect(response.status).toBe(404);
  });
});

describe('deciding an appeal', () => {
  it('upheld lifts the punishment, sends exactly one punishment.lift and says the product applied it', async () => {
    const { post, get, sent } = setup();
    const response = await post('/desk/tickets/ap1/appeal', { outcome: 'upheld' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/ap1?appeal=applied');
    expect(sent.map((s) => s.type)).toEqual(['punishment.lift']);
    expect(await (await get('/desk/tickets/ap1?appeal=applied')).text()).toContain('Appeal upheld: the product lifted the punishment.');
  });

  it('rejected sends nothing and says so', async () => {
    const { post, get, sent } = setup();
    const response = await post('/desk/tickets/ap1/appeal', { outcome: 'rejected' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/ap1?appeal=rejected');
    expect(sent).toEqual([]);
    expect(await (await get('/desk/tickets/ap1?appeal=rejected')).text()).toContain('Appeal rejected. No further appeal is taken.');
  });

  it.each([
    ['failed', 'Appeal upheld and the punishment lifted here, but the product did not apply the lift. Send it again from the report.'],
    ['upheld', 'Appeal upheld. The punishment was already lifted.'],
  ])('says what %s means', async (outcome, line) => {
    expect(await (await setup().get(`/desk/tickets/ap1?appeal=${outcome}`)).text()).toContain(line);
  });

  it('is 404 for a rep, writing and sending nothing', async () => {
    const { post, statements, sent } = setup();
    const response = await post('/desk/tickets/ap1/appeal', { outcome: 'upheld' }, REP);
    expect(response.status).toBe(404);
    expect(statements.some((s) => /^(UPDATE|INSERT)/.test(s.sql))).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses an appeal already decided, saying so', async () => {
    const { post, get, sent } = setup({ state: 'rejected', decided_by: ADMIN, decided_at: 1, lifted_at: null });
    const response = await post('/desk/tickets/ap1/appeal', { outcome: 'upheld' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/ap1?error=already_decided');
    expect(sent).toEqual([]);
    expect(await (await get('/desk/tickets/ap1?error=already_decided')).text()).toContain('This appeal was already decided.');
  });

  it('refuses an outcome that is neither, writing nothing', async () => {
    const { post, get, statements } = setup();
    const response = await post('/desk/tickets/ap1/appeal', { outcome: 'maybe' });
    expect(response.headers.get('Location')).toBe('/desk/tickets/ap1?error=unknown_outcome');
    expect(statements.some((s) => /^UPDATE/.test(s.sql))).toBe(false);
    expect(await (await get('/desk/tickets/ap1?error=unknown_outcome')).text()).toContain('Choose to uphold or reject the appeal.');
  });

  it('is 404 for a rep sending an outcome that is neither, telling them nothing', async () => {
    const { post, statements } = setup();
    expect((await post('/desk/tickets/ap1/appeal', { outcome: 'maybe' }, REP)).status).toBe(404);
    expect(statements.some((s) => /FROM appeals/.test(s.sql))).toBe(false);
  });

  it('is 404 for the admin sending an outcome that is neither on a ticket that is not an appeal', async () => {
    expect((await setup().post('/desk/tickets/zz/appeal', { outcome: 'maybe' })).status).toBe(404);
  });

  it('lets a database failure through as a 500', async () => {
    const { post } = setup({ state: 'open', decided_by: null, decided_at: null, lifted_at: null }, true);
    expect((await post('/desk/tickets/ap1/appeal', { outcome: 'rejected' })).status).toBe(500);
  });

  it('is 404 for the admin on a ticket that is not an appeal', async () => {
    expect((await setup().post('/desk/tickets/zz/appeal', { outcome: 'rejected' })).status).toBe(404);
  });
});
