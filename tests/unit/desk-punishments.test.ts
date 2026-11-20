import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { PUBLIC_JWK, signingKey } from '../fixtures/access-keys.ts';
import { deskRoutes, type DeskBindings } from '../../src/desk/routes.ts';
import type { Fetcher } from '../../src/punishments/send.ts';
import { standInDb, type Statement } from './d1-stand-in.ts';

// Reports and punishments on the staff desk (shyden-labs/shydesk#60; Release 2 plan
// Task 4): a report ticket shows what was reported, the reported user's history in
// this product, a punishment picker, and each punishment's state, with "Send again"
// while it is failed. A rep acts only within their products; only the admin lifts.

const TEAM = 'shydesk-test.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-desk';
const ADMIN = 'admin@example.com';
const REP = 'rep@example.com';
const OUTSIDER = 'other-rep@example.com';
const ORIGIN = 'http://localhost';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let jwks: JWTVerifyGetKey;
let sign: (email: string) => Promise<string>;

beforeAll(async () => {
  const privateKey = await signingKey();
  jwks = createLocalJWKSet({ keys: [{ ...PUBLIC_JWK, kid: 'k1', alg: 'RS256' }] });
  sign = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setAudience(AUD)
      .setIssuer(`https://${TEAM}`)
      .setExpirationTime('5m')
      .sign(privateKey);
});

const REPORT_TICKET = {
  id: 'r1',
  product_id: 'shytalk',
  type_id: 'shytalk:report',
  status: 'open',
  customer_email: '',
  subject: 'Harassment: message msg-9',
  category: 'Harassment',
  fields_json: '{}',
  created_at: 5,
  updated_at: 6,
  seq: 3,
  token_sealed: null,
  text_deleted_at: null,
};

const punishment = (over: Record<string, unknown> = {}) => ({
  id: 'pun-1',
  product_id: 'shytalk',
  report_ticket_id: 'r1',
  subject_user_id: 'user-2',
  punishment_key: 'ban-7d',
  label: 'Ban 7 days',
  duration_seconds: 604800,
  applied_by: REP,
  created_at: 7,
  send_state: 'failed',
  send_error: 'http_500 user_gone',
  appeal_token_hash: 'h',
  lifted_at: null,
  lifted_by: null,
  lift_state: null,
  lift_error: null,
  ...over,
});

interface Options {
  /** The report row is missing, as for a ticket of the report type with no report behind it. */
  noReport?: boolean;
  /** The subject's earlier reports and punishments in this product. */
  history?: { reports: Record<string, unknown>[]; punishments: Record<string, unknown>[] };
  /** The product's punishments to pick from. */
  choices?: Record<string, unknown>[];
  /** Writing a punishment fails, as when D1 is down. */
  insertFails?: boolean;
}

function setup(punishments: Record<string, unknown>[] = [punishment()], o: Options = {}) {
  const { db, statements } = standInDb((sql, values) => {
    if (o.insertFails === true && /^INSERT INTO punishments/.test(sql)) throw new Error('D1 is down');
    if (/FROM staff_products/.test(sql))
      return values[0] === REP ? [{ product_id: 'shytalk' }] : values[0] === OUTSIDER ? [{ product_id: 'yawelo-idle' }] : [];
    if (/FROM staff WHERE/.test(sql)) return values[0] === REP || values[0] === OUTSIDER ? [{ role: 'rep' }] : [];
    if (/SELECT id FROM products ORDER BY id/.test(sql)) return [{ id: 'shytalk' }, { id: 'yawelo-idle' }];
    if (/SELECT punishments_json FROM products/.test(sql)) {
      return [
        {
          punishments_json: JSON.stringify(
            o.choices ?? [
              { key: 'ban-7d', label: 'Ban 7 days', duration_seconds: 604800 },
              { key: 'mute', label: 'Mute <1h>', duration_seconds: 3600 },
            ],
          ),
        },
      ];
    }
    if (/SELECT callback_url, callback_secret, appeal_page_url FROM products/.test(sql)) {
      return [{ callback_url: 'https://api.shytalk.example/punish', callback_secret: 'sec', appeal_page_url: null }];
    }
    if (/FROM tickets t JOIN reports r ON r.ticket_id = t.id WHERE t.id = \?/.test(sql)) {
      return values[0] === 'r1' && values.slice(1).includes('shytalk')
        ? [{ id: 'r1', product_id: 'shytalk', subject_user_id: 'user-2' }]
        : [];
    }
    if (/FROM reports WHERE ticket_id = \?/.test(sql)) {
      if (o.noReport === true) return [];
      return [
        {
          reporter_id: 'user-1',
          item_kind: 'message',
          item_id: 'msg-9',
          subject_user_id: 'user-2',
          reason: 'Harassment',
          context_json: '{"room":"lobby"}',
        },
      ];
    }
    if (/FROM reports r JOIN tickets t/.test(sql))
      return o.history?.reports ?? [{ ticket_id: 'r0', reason: 'Cheating', created_at: 1, status: 'closed' }];
    if (/FROM punishments WHERE product_id = \? AND subject_user_id = \?/.test(sql)) {
      return o.history?.punishments ?? [{ id: 'p0', label: 'Warning', created_at: 2, send_state: 'applied', lifted_at: null }];
    }
    if (/FROM punishments WHERE report_ticket_id = \?/.test(sql)) return punishments;
    if (/FROM punishments WHERE id = \?/.test(sql)) {
      const found = punishments.find((p) => p.id === values[0]);
      return found && values.slice(1).includes(found.product_id) ? [found] : [];
    }
    if (/FROM tickets WHERE id = \? AND product_id IN/.test(sql))
      return values.slice(1).includes('shytalk') && values[0] === 'r1' ? [REPORT_TICKET] : [];
    if (/FROM messages/.test(sql))
      return [{ id: 'm1', author: 'customer', staff_email: null, body: 'Said this three times.', created_at: 5 }];
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
  const get = async (path: string, who = REP) =>
    app.request(path, { headers: { 'Cf-Access-Jwt-Assertion': await sign(who), Origin: ORIGIN } }, env);
  const post = async (path: string, form: Record<string, string> = {}, who = REP) =>
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

const writes = (statements: Statement[]) => statements.filter((s) => /^(INSERT INTO punishments|UPDATE punishments)/.test(s.sql));

describe('a report ticket on the desk', () => {
  it('shows what was reported, the history, the picker and each punishment with its state', async () => {
    const page = await (await setup().get('/desk/tickets/r1')).text();
    expect.soft(page).toContain('Reported by user-1');
    expect.soft(page).toContain('message msg-9');
    expect.soft(page).toContain('About user-2');
    expect.soft(page).toContain('Cheating');
    expect.soft(page).toContain('Warning');
    expect.soft(page).toContain('<option value="ban-7d">Ban 7 days</option>');
    expect.soft(page).toContain('Mute &lt;1h&gt;');
    expect.soft(page).toContain('Ban 7 days: failed (http_500 user_gone)');
    expect.soft(page).toContain('action="/desk/punishments/pun-1/resend"');
  });

  it('offers no "Send again" for a punishment that was applied', async () => {
    const page = await (await setup([punishment({ send_state: 'applied', send_error: null })]).get('/desk/tickets/r1')).text();
    expect.soft(page).toContain('Ban 7 days: applied');
    expect.soft(page).not.toContain('/resend');
  });

  it('offers "Lift" to the admin only', async () => {
    const applied = [punishment({ send_state: 'applied', send_error: null })];
    expect(await (await setup(applied).get('/desk/tickets/r1', ADMIN)).text()).toContain('action="/desk/punishments/pun-1/lift"');
    expect(await (await setup(applied).get('/desk/tickets/r1', REP)).text()).not.toContain('/lift');
  });

  it('offers no "Send again" for the failed apply of a lifted punishment', async () => {
    const lifted = [punishment({ lifted_at: 9, lifted_by: ADMIN, lift_state: 'applied', lift_error: null })];
    expect(await (await setup(lifted).get('/desk/tickets/r1', REP)).text()).not.toContain('/resend');
    expect(await (await setup(lifted).get('/desk/tickets/r1', ADMIN)).text()).not.toContain('/resend');
  });

  it('offers a rep no "Send again" for a failed lift, which only the admin re-sends', async () => {
    const lifted = [
      punishment({ send_state: 'applied', send_error: null, lifted_at: 9, lifted_by: ADMIN, lift_state: 'failed', lift_error: 'timeout' }),
    ];
    expect(await (await setup(lifted).get('/desk/tickets/r1', REP)).text()).not.toContain('/resend');
  });

  it("shows a lifted punishment and its lift's state", async () => {
    const lifted = [
      punishment({ send_state: 'applied', send_error: null, lifted_at: 9, lifted_by: ADMIN, lift_state: 'failed', lift_error: 'timeout' }),
    ];
    const page = await (await setup(lifted).get('/desk/tickets/r1', ADMIN)).text();
    expect.soft(page).toContain('lifted by admin@example.com, lift failed (timeout)');
    expect.soft(page).toContain('action="/desk/punishments/pun-1/resend"');
  });
});

describe('punishing from the desk', () => {
  it('applies the picked punishment, sends it once and goes back to the report', async () => {
    const { post, statements, sent } = setup();
    const response = await post('/desk/tickets/r1/punish', { key: 'ban-7d' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/r1?punishment=applied');
    expect(writes(statements).filter((s) => s.sql.startsWith('INSERT'))).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("is 404 for a rep out of scope applying on another product's report, writing and sending nothing", async () => {
    const { post, statements, sent } = setup();
    expect((await post('/desk/tickets/r1/punish', { key: 'ban-7d' }, OUTSIDER)).status).toBe(404);
    expect(writes(statements)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('goes back with an error for a punishment the product does not list', async () => {
    const { post, sent } = setup();
    const response = await post('/desk/tickets/r1/punish', { key: 'nope' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/r1?error=unknown_punishment');
    expect(sent).toEqual([]);
  });

  it('says on the page what happened to the last punishment sent', async () => {
    const page = await (await setup().get('/desk/tickets/r1?punishment=failed')).text();
    expect(page).toContain('The punishment was recorded, but the product did not apply it.');
  });

  it('"Send again" re-sends the same punishment id', async () => {
    const { post, sent } = setup();
    const response = await post('/desk/punishments/pun-1/resend');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/r1?punishment=applied');
    expect(sent.map((b) => b.punishment_id)).toEqual(['pun-1']);
  });

  it('is 404 for a rep lifting, writing and sending nothing', async () => {
    const { post, statements, sent } = setup([punishment({ send_state: 'applied', send_error: null })]);
    expect((await post('/desk/punishments/pun-1/lift', {}, REP)).status).toBe(404);
    expect(writes(statements)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('lets the admin lift and goes back to the report', async () => {
    const { post, sent } = setup([punishment({ send_state: 'applied', send_error: null })]);
    const response = await post('/desk/punishments/pun-1/lift', {}, ADMIN);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/r1?punishment=applied');
    expect(sent[0]?.type).toBe('punishment.lift');
  });

  it('is 404 for a punishment that does not exist', async () => {
    expect((await setup().post('/desk/punishments/nope/resend')).status).toBe(404);
    expect((await setup().post('/desk/punishments/nope/lift', {}, ADMIN)).status).toBe(404);
  });
});

describe('report page edges (shyden-labs/shydesk#60)', () => {
  it('shows a report-type ticket with no report behind it as a plain ticket', async () => {
    const response = await setup([], { noReport: true }).get('/desk/tickets/r1');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('aria-label="Report"');
  });

  it('says so when the subject has nothing earlier in this product', async () => {
    const page = await (await setup([], { history: { reports: [], punishments: [] } }).get('/desk/tickets/r1')).text();
    expect(page).toContain('Nothing earlier.');
  });

  it('marks an earlier punishment that was lifted', async () => {
    const history = { reports: [], punishments: [{ id: 'p0', label: 'Warning', created_at: 2, send_state: 'applied', lifted_at: 3 }] };
    expect(await (await setup([], { history }).get('/desk/tickets/r1')).text()).toContain('Punishment: Warning · applied · lifted');
  });

  it('says so when the product has no punishments set, offering no picker', async () => {
    const page = await (await setup([], { choices: [] }).get('/desk/tickets/r1')).text();
    expect.soft(page).toContain('This product has no punishments set.');
    expect.soft(page).not.toContain('/punish"');
  });

  it('shows a lift still being sent, before anything is recorded about it', async () => {
    const lifting = [punishment({ send_state: 'applied', send_error: null, lifted_at: 9, lifted_by: null, lift_state: null })];
    expect(await (await setup(lifting).get('/desk/tickets/r1', ADMIN)).text()).toContain('Ban 7 days: applied, lifted by , lift sending');
  });

  it('shows no punishment line for an error it does not know', async () => {
    const page = await (await setup().get('/desk/tickets/r1?error=something-else')).text();
    expect(page).toContain('Said this three times.');
    expect(page).not.toContain('aria-label="Reply status"');
  });
});

describe('punishment refusals and failures on the desk (shyden-labs/shydesk#60)', () => {
  it('goes back with an error when "Send again" has nothing to send', async () => {
    const { post, sent } = setup([punishment({ send_state: 'applied', send_error: null })]);
    const response = await post('/desk/punishments/pun-1/resend');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/desk/tickets/r1?error=nothing_to_send');
    expect(sent).toEqual([]);
  });

  it('treats a form with no punishment picked as an unknown punishment', async () => {
    const response = await setup().post('/desk/tickets/r1/punish');
    expect(response.headers.get('Location')).toBe('/desk/tickets/r1?error=unknown_punishment');
  });

  it('answers 500 when the database fails, rather than saying it was sent', async () => {
    const { post, sent } = setup([], { insertFails: true });
    expect((await post('/desk/tickets/r1/punish', { key: 'ban-7d' })).status).toBe(500);
    expect(sent).toEqual([]);
  });
});
