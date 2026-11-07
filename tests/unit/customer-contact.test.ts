import { describe, expect, it } from 'vitest';
import { contactRoutes, type ContactDeps } from '../../src/customer/contact.ts';
import { MESSAGES } from '../../src/customer/messages.ts';
import type { SmtpLogin, SmtpMail } from '../../src/mail/smtp.ts';
import { standInDb, type Statement } from './d1-stand-in.ts';

// The contact form's API (shyden-labs/shydesk#19; plan Task 5): the form's
// settings, and a new ticket checked field by field, by Turnstile (solved on
// one of the product's own hosts), and by two rate limits (5 per email and
// 20 per client IP per hour), answered with the private link and whether the
// notice email went.
const ORIGIN = 'https://shytalk.app';
const PRODUCT = {
  id: 'shytalk',
  name: 'ShyTalk',
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: JSON.stringify([ORIGIN, 'http://localhost:8788']),
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
};
const TYPE = {
  id: 'shytalk:support',
  name: 'Support',
  fields_json: JSON.stringify([
    { label: 'Device', kind: 'text', required: true },
    { label: 'Plan', kind: 'select', required: false, options: ['Free', 'Plus'] },
  ]),
};

interface World {
  type?: typeof TYPE | null;
  counts?: { email?: number; ip?: number };
  attachments?: string[];
  turnstile?: { success: boolean; hostname?: string; metadata?: { result_with_testing_key: boolean } };
  mailFails?: boolean;
  noSecret?: boolean;
  ticketWriteFails?: boolean;
}

function appWith(world: World = {}) {
  const { db, statements } = standInDb((sql, values) => {
    if (world.ticketWriteFails && sql.includes('INSERT INTO tickets')) throw new Error('D1 is down');
    if (sql.includes('FROM products')) return values[0] === 'shytalk' ? [PRODUCT] : [];
    if (sql.includes('FROM ticket_types')) return world.type === null ? [] : [world.type ?? TYPE];
    if (sql.includes('INSERT INTO counters') && String(values[0]).startsWith('contact:email:'))
      return [{ value: world.counts?.email ?? 1 }];
    if (sql.includes('INSERT INTO counters') && String(values[0]).startsWith('contact:ip:')) return [{ value: world.counts?.ip ?? 1 }];
    if (sql.includes('INSERT INTO counters') && String(values[0]).startsWith('mail:')) return [{ value: 1 }];
    if (sql.includes('FROM attachments')) return (world.attachments ?? []).map((id) => ({ id }));
    return [];
  });
  const sent: SmtpMail[] = [];
  const siteverify: URLSearchParams[] = [];
  const deps: ContactDeps = {
    fetcher: (_url, init) => {
      siteverify.push(new URLSearchParams(init?.body as URLSearchParams));
      return Promise.resolve(Response.json(world.turnstile ?? { success: true, hostname: 'shytalk.app' }));
    },
    deliver: (_login: SmtpLogin, mail: SmtpMail) => {
      if (world.mailFails) return Promise.reject(new Error('550 refused'));
      sent.push(mail);
      return Promise.resolve();
    },
  };
  const app = contactRoutes(deps);
  const env = {
    DB: db,
    ...(world.noSecret ? {} : { TURNSTILE_SECRET: 'secret' }),
    TURNSTILE_SITE_KEY: 'site-key',
    SMTP_LOGINS: JSON.stringify({ 'no-reply@shytalk.app': { user: 'u', pass: 'p' } }),
  };
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' };
  const post = (body: unknown, product = 'shytalk') =>
    app.request(
      `/support-api/tickets?product=${product}`,
      { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
      env,
    );
  const config = (product = 'shytalk') => app.request(`/support-api/config?product=${product}`, { headers }, env);
  return { post, config, statements, sent, siteverify };
}

const good = (over: Record<string, unknown> = {}) => ({
  email: 'ana@example.com',
  subject: 'Cannot sign in',
  category: 'account',
  message: 'The code never arrives.',
  fields: { Device: 'Pixel 9' },
  attachmentIds: [],
  turnstileToken: 'tok',
  ...over,
});

const ticketInserts = (statements: Statement[]) => statements.filter((s) => s.sql.includes('INSERT INTO tickets'));

describe('GET /support-api/config', () => {
  it('gives the product, its support type and fields, the categories, the Turnstile site key and the attachment limits', async () => {
    const { config } = appWith();
    const response = await config();
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await response.json()).toEqual({
      product: { id: 'shytalk', name: 'ShyTalk' },
      types: [{ id: 'shytalk:support', name: 'Support', fields: JSON.parse(TYPE.fields_json) as unknown }],
      categories: ['question', 'bug', 'account', 'payment', 'other'],
      turnstileSiteKey: 'site-key',
      maxAttachments: 10,
      maxVideoSeconds: 30,
    });
  });

  it('gives no types while the product has no support type set up', async () => {
    const { config } = appWith({ type: null });
    expect(((await (await config()).json()) as { types: unknown[] }).types).toEqual([]);
  });

  it('answers an unknown product with 404 and no CORS header', async () => {
    const { config } = appWith();
    const response = await config('nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('POST /support-api/tickets', () => {
  it('creates the ticket, mails the notice and answers with the private link', async () => {
    const { post, statements, sent } = appWith();
    const response = await post(good());
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ticketLink: string; emailSent: boolean };
    expect(body.emailSent).toBe(true);
    expect(body.ticketLink).toMatch(/^https:\/\/shytalk\.app\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);
    expect(ticketInserts(statements)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ana@example.com');
    expect(sent[0]?.text).toContain(body.ticketLink);
  });

  it('still creates the ticket and gives the link when the email could not be sent', async () => {
    const { post, statements } = appWith({ mailFails: true });
    const response = await post(good());
    expect(response.status).toBe(201);
    expect(((await response.json()) as { emailSent: boolean }).emailSent).toBe(false);
    expect(ticketInserts(statements)).toHaveLength(1);
  });

  it('keeps only the type fields, trimmed, and stores the email lower-cased', async () => {
    const { post, statements } = appWith();
    await post(good({ email: ' Ana@Example.COM ', fields: { Device: ' Pixel 9 ', Plan: 'Plus', Extra: 'dropped' } }));
    const values = ticketInserts(statements)[0]?.values ?? [];
    expect(values[3]).toBe('ana@example.com');
    expect(values[6]).toBe(JSON.stringify({ Device: 'Pixel 9', Plan: 'Plus' }));
  });

  it('checks Turnstile with the secret and the client IP', async () => {
    const { post, siteverify } = appWith();
    await post(good());
    expect(Object.fromEntries(siteverify[0] ?? [])).toEqual({ secret: 'secret', response: 'tok', remoteip: '203.0.113.9' });
  });

  it('refuses a failed Turnstile, creating nothing', async () => {
    const { post, statements } = appWith({ turnstile: { success: false } });
    const response = await post(good());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { turnstileToken: MESSAGES.turnstile } });
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it("refuses a Turnstile result solved on a host that is not one of the product's", async () => {
    const { post, statements } = appWith({ turnstile: { success: true, hostname: 'evil.example' } });
    const response = await post(good());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { turnstileToken: MESSAGES.turnstile } });
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it('accepts a result from a testing key, which names no real host', async () => {
    const { post } = appWith({ turnstile: { success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } } });
    expect((await post(good())).status).toBe(201);
  });

  it('accepts a Turnstile result solved on any of the product hosts, port or not', async () => {
    const { post } = appWith({ turnstile: { success: true, hostname: 'localhost' } });
    expect((await post(good())).status).toBe(201);
  });

  it('refuses the 6th ticket from one email within the hour', async () => {
    const { post, statements } = appWith({ counts: { email: 6 } });
    const response = await post(good());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: MESSAGES.tooMany });
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it('lets the 5th ticket from one email through', async () => {
    const { post } = appWith({ counts: { email: 5 } });
    expect((await post(good())).status).toBe(201);
  });

  it('refuses the 21st ticket from one IP within the hour', async () => {
    const { post, statements } = appWith({ counts: { ip: 21 } });
    const response = await post(good());
    expect(response.status).toBe(429);
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it('counts the email limit by the lower-cased email and the IP limit by the client IP, an hour each', async () => {
    const { post, statements } = appWith({ counts: { ip: 20 } });
    await post(good({ email: 'Ana@Example.com' }));
    const counted = statements.filter((s) => String(s.values[0]).startsWith('contact:'));
    expect(counted.map((s) => s.values[0])).toEqual(['contact:ip:203.0.113.9', 'contact:email:ana@example.com']);
    expect(counted.every((s) => (s.values[1] as number) - (s.values[2] as number) === 3_600_000)).toBe(true);
  });

  it('does not count a request that failed Turnstile', async () => {
    const { post, statements } = appWith({ turnstile: { success: false } });
    await post(good());
    expect(statements.some((s) => String(s.values[0]).startsWith('contact:'))).toBe(false);
  });

  it('takes the attachments the product finished uploading', async () => {
    const { post, statements } = appWith({ attachments: ['a1'] });
    expect((await post(good({ attachmentIds: ['a1'] }))).status).toBe(201);
    expect(statements.some((s) => s.sql.startsWith('UPDATE attachments'))).toBe(true);
  });

  it('refuses an attachment it cannot take, creating nothing', async () => {
    const { post, statements } = appWith({ attachments: [] });
    const response = await post(good({ attachmentIds: ['theirs'] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { attachmentIds: MESSAGES.attachmentMissing } });
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it.each([
    ['email', { email: '' }, MESSAGES.emailInvalid],
    ['email', { email: 'not-an-email' }, MESSAGES.emailInvalid],
    ['email', { email: `${'a'.repeat(250)}@b.co` }, MESSAGES.emailInvalid],
    ['subject', { subject: '   ' }, MESSAGES.subjectRequired],
    ['subject', { subject: 's'.repeat(151) }, MESSAGES.subjectTooLong],
    ['category', { category: 'refund' }, MESSAGES.categoryInvalid],
    ['message', { message: '' }, MESSAGES.messageRequired],
    ['message', { message: 'm'.repeat(10_001) }, MESSAGES.messageTooLong],
    ['fields.Device', { fields: {} }, MESSAGES.fieldRequired],
    ['fields.Device', { fields: { Device: 'd'.repeat(1_001) } }, MESSAGES.fieldTooLong],
    ['fields.Plan', { fields: { Device: 'x', Plan: 'Gold' } }, MESSAGES.fieldChoice],
    ['attachmentIds', { attachmentIds: Array.from({ length: 11 }, (_, i) => `a${i}`) }, MESSAGES.tooManyAttachments],
    ['turnstileToken', { turnstileToken: '' }, MESSAGES.turnstile],
  ])('refuses a bad %s with its own message', async (field, over, message) => {
    const { post, statements, siteverify } = appWith();
    const response = await post(good(over));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { [field]: message } });
    expect(ticketInserts(statements)).toHaveLength(0);
    expect(siteverify).toHaveLength(0);
  });

  it('treats a field sent as something other than text as empty', async () => {
    const { post } = appWith();
    const response = await post(good({ email: 42 }));
    expect(await response.json()).toEqual({ errors: { email: MESSAGES.emailInvalid } });
  });

  it('reads missing extra fields and attachments as none', async () => {
    const { post } = appWith();
    const { fields: _fields, attachmentIds: _ids, ...bare } = good();
    const response = await post(bare);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errors: { 'fields.Device': MESSAGES.fieldRequired } });
  });

  it('refuses any answer to a choice field that has no options', async () => {
    const type = { ...TYPE, fields_json: JSON.stringify([{ label: 'Plan', kind: 'select', required: false }]) };
    const { post } = appWith({ type });
    const response = await post(good({ fields: { Plan: 'Free' } }));
    expect(await response.json()).toEqual({ errors: { 'fields.Plan': MESSAGES.fieldChoice } });
  });

  it('answers 503 and names the missing setting when the Turnstile secret is not set, asking nothing of siteverify', async () => {
    const { post, statements, siteverify } = appWith({ noSecret: true });
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    try {
      const response = await post(good());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: MESSAGES.unavailable });
    } finally {
      console.error = original;
    }
    expect(logged).toEqual(['TURNSTILE_SECRET is not set: no support request can be checked']);
    expect(siteverify).toHaveLength(0);
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it('fails the request when the ticket cannot be written, sending no email', async () => {
    const { post, sent } = appWith({ ticketWriteFails: true });
    const response = await post(good());
    expect(response.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it('accepts a subject of exactly 150 and a message of exactly 10,000 characters', async () => {
    const { post } = appWith();
    expect((await post(good({ subject: 's'.repeat(150), message: 'm'.repeat(10_000) }))).status).toBe(201);
  });

  it('names every bad field at once', async () => {
    const { post } = appWith();
    const response = await post(good({ email: 'x', subject: '', message: '' }));
    expect(Object.keys(((await response.json()) as { errors: object }).errors).sort()).toEqual(['email', 'message', 'subject']);
  });

  it.each([
    ['a body that is not JSON', '{'],
    ['a body that is not an object', '[]'],
    ['fields that are not an object', JSON.stringify(good({ fields: ['Pixel'] }))],
    ['attachment ids that are not a list of strings', JSON.stringify(good({ attachmentIds: [1] }))],
    ['a field value that is not text', JSON.stringify(good({ fields: { Device: 9 } }))],
  ])('refuses %s', async (_case, body) => {
    const { post, statements } = appWith();
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it('answers 404 while the product has no support type set up', async () => {
    const { post, statements } = appWith({ type: null });
    expect((await post(good())).status).toBe(404);
    expect(ticketInserts(statements)).toHaveLength(0);
  });

  it('answers an unknown product with 404 and no CORS header', async () => {
    const { post } = appWith();
    const response = await post(good(), 'nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
