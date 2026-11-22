import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { contactRoutes } from '../../src/customer/contact.ts';
import { app } from '../../src/index.ts';
import { hashKey } from '../../src/products.ts';
import { uploadRoutes } from '../../src/uploads/routes.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// The hand-written spec, openapi/shydesk.v1.yaml, is the contract product
// servers and the shared piece code against (shyden-labs/shydesk#26). Every
// route the Worker registers under /api/v1 and /support-api is in it, every
// path in it is registered, and every response the Worker gives validates
// against the schema the spec documents for that status.
interface Answered {
  $ref?: string;
  content?: { 'application/json'?: { schema: unknown } };
}
interface Operation {
  responses: Record<string, Answered>;
}
interface Spec {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, Answered> };
}

const spec = parse(readFileSync(new URL('../../openapi/shydesk.v1.yaml', import.meta.url), 'utf8')) as Spec;
const PUBLIC_PREFIXES = ['/api/v1/', '/support-api/'];
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const registered = (): string[] =>
  [
    ...new Set(
      app.routes
        .filter((r) => r.method !== 'ALL' && PUBLIC_PREFIXES.some((p) => r.path.startsWith(p)))
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
    ),
  ].sort();

const documented = (): string[] =>
  Object.entries(spec.paths)
    .flatMap(([path, ops]) =>
      Object.keys(ops)
        .filter((m) => METHODS.has(m))
        .map((m) => `${m} ${path}`),
    )
    .sort();

// Each component schema is registered under its own id, and the spec's
// `#/components/schemas/X` references are pointed at those ids.
const SCHEMA_ID = 'https://shydesk.dpdns.org/openapi/schemas/';
const pointAtIds = (schema: unknown): object =>
  JSON.parse(JSON.stringify(schema).replaceAll('"#/components/schemas/', `"${SCHEMA_ID}`)) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const [name, schema] of Object.entries(spec.components.schemas)) {
  ajv.addSchema({ ...pointAtIds(schema), $id: `${SCHEMA_ID}${name}` });
}

/** Validates a body against the schema the spec gives this path, method and status. */
function check(path: string, method: string, status: number, body: unknown): string[] {
  const documented = spec.paths[path]?.[method]?.responses[String(status)];
  const shared = documented?.$ref?.replace('#/components/responses/', '');
  const response = shared === undefined ? documented : spec.components.responses[shared];
  if (!response) return [`${method} ${path} does not document status ${status}`];
  const schema = response.content?.['application/json']?.schema;
  if (!schema) return [`${method} ${path} ${status} has no application/json schema`];
  const validate = ajv.compile(pointAtIds(schema));
  return validate(body) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`);
}

const KEY = 'contract-key';
async function call(url: string, key = KEY) {
  const hash = await hashKey(KEY);
  const answer: Answer = (sql, values) => {
    if (sql.includes('FROM api_keys')) return values[0] === hash ? [{ product_id: 'shytalk', revoked_at: null }] : [];
    if (sql.includes('FROM tickets')) {
      return [
        { id: 't1', status: 'closed', subject: 'S', category: 'bug', created_at: 1, updated_at: 2, closed_at: 3, seq: 9 },
        { id: 't2', status: 'open', subject: 'S', category: 'other', created_at: 1, updated_at: 2, closed_at: null, seq: 10 },
      ];
    }
    return [];
  };
  const response = await app.request(url, { headers: { Authorization: `Bearer ${key}` } }, { DB: standInDb(answer).db });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe('openapi/shydesk.v1.yaml', () => {
  it('is OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('documents every public route the Worker registers, and nothing else', () => {
    expect(registered().length).toBeGreaterThan(0);
    expect(documented()).toEqual(registered());
  });

  const FEED = '/api/v1/products/{product}/feed';
  it.each([
    ['a page of tickets', '/api/v1/products/shytalk/feed?since_cursor=3', KEY, 200],
    ['a bad limit', '/api/v1/products/shytalk/feed?limit=0', KEY, 400],
    ['an unknown key', '/api/v1/products/shytalk/feed', 'unknown', 401],
    ["another product's feed", '/api/v1/products/yawelo-idle/feed', KEY, 404],
  ])('the feed answer to %s matches the spec', async (_case, url, key, status) => {
    const answer = await call(url, key);
    expect(answer.status).toBe(status);
    expect(check(FEED, 'get', answer.status, answer.body)).toEqual([]);
  });

  it('would catch a response that strays from the spec', () => {
    expect(check(FEED, 'get', 200, { items: [{ id: 't1' }], next_cursor: 1 })).not.toEqual([]);
    expect(check(FEED, 'get', 200, { items: [], next_cursor: 1, extra: true })).not.toEqual([]);
    expect(check(FEED, 'get', 418, {})).toEqual([`get ${FEED} does not document status 418`]);
  });
});

// The reports API (shyden-labs/shydesk#59): each answer of the three new paths
// matches the status and schema the spec gives it.
async function reportsCall(method: 'GET' | 'POST', url: string, body?: unknown, key = KEY, counted = 1) {
  const hash = await hashKey(KEY);
  const answer: Answer = (sql, values) => {
    if (sql.includes('FROM api_keys')) return values[0] === hash ? [{ product_id: 'shytalk', revoked_at: null }] : [];
    if (sql.includes('RETURNING value') && String(values[0]).startsWith('reports:')) return [{ value: counted }];
    if (sql.includes('FROM ticket_types')) return [{ reasons_json: '["Cheating"]' }];
    if (sql.includes('WHERE r.ticket_id = ?')) {
      return values[0] === 'r1'
        ? [
            {
              id: 'r1',
              status: 'open',
              created_at: 5,
              reporter_id: 'u1',
              item_kind: 'player',
              item_id: 'u2',
              subject_user_id: 'u2',
              reason: 'Cheating',
              context_json: '{}',
              note: '',
            },
          ]
        : [];
    }
    if (sql.includes('FROM reports r JOIN tickets t')) return [{ ticket_id: 'r0', reason: 'Cheating', created_at: 1, status: 'closed' }];
    if (sql.includes('FROM punishments')) return [{ id: 'p1', label: 'Ban', created_at: 2, send_state: 'failed', lifted_at: null }];
    return [];
  };
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(url, init, { DB: standInDb(answer).db });
  return { status: response.status, body: (await response.json()) as unknown };
}

const NEW_REPORT = { reporter_id: 'u1', item: { kind: 'player', id: 'u2' }, subject_user_id: 'u2', reason: 'Cheating' };

describe('openapi/shydesk.v1.yaml for the reports API', () => {
  const REPORTS = '/api/v1/products/{product}/reports';
  it.each([
    ['a report', NEW_REPORT, KEY, 1, 202],
    ['a bad body', { reporter_id: '' }, KEY, 1, 400],
    ['an unknown key', NEW_REPORT, 'unknown', 1, 401],
    ['an unknown reason', { ...NEW_REPORT, reason: 'Other' }, KEY, 1, 422],
    ['an unknown upload', { ...NEW_REPORT, upload_ids: ['nope'] }, KEY, 1, 422],
    ['the 121st report in a minute', NEW_REPORT, KEY, 121, 429],
  ])('the reports answer to %s matches the spec', async (_case, body, key, counted, status) => {
    const answer = await reportsCall('POST', '/api/v1/products/shytalk/reports', body, key, counted);
    expect(answer.status).toBe(status);
    expect(check(REPORTS, 'post', answer.status, answer.body)).toEqual([]);
  });

  it("the reports answer to another product's key matches the spec", async () => {
    const answer = await reportsCall('POST', '/api/v1/products/yawelo-idle/reports', NEW_REPORT);
    expect(answer.status).toBe(404);
    expect(check(REPORTS, 'post', 404, answer.body)).toEqual([]);
  });

  const GRANTS = '/api/v1/products/{product}/upload-grants';
  it.each([
    ['a grant', '/api/v1/products/shytalk/upload-grants', { count: 2 }, KEY, 201],
    ['a count of 11', '/api/v1/products/shytalk/upload-grants', { count: 11 }, KEY, 400],
    ['an unknown key', '/api/v1/products/shytalk/upload-grants', { count: 2 }, 'unknown', 401],
    ["another product's key", '/api/v1/products/yawelo-idle/upload-grants', { count: 2 }, KEY, 404],
  ])('the upload grant answer to %s matches the spec', async (_case, url, body, key, status) => {
    const answer = await reportsCall('POST', url, body, key);
    expect(answer.status).toBe(status);
    expect(check(GRANTS, 'post', answer.status, answer.body)).toEqual([]);
  });

  const REPORT = '/api/v1/products/{product}/reports/{id}';
  it.each([
    ['a report with its history', '/api/v1/products/shytalk/reports/r1', KEY, 200],
    ['an unknown key', '/api/v1/products/shytalk/reports/r1', 'unknown', 401],
    ['a report that does not exist', '/api/v1/products/shytalk/reports/nope', KEY, 404],
  ])('the report answer to %s matches the spec', async (_case, url, key, status) => {
    const answer = await reportsCall('GET', url, undefined, key);
    expect(answer.status).toBe(status);
    expect(check(REPORT, 'get', answer.status, answer.body)).toEqual([]);
  });
});

// The customer API, through the contact routes with Turnstile and mail stood
// in (shyden-labs/shydesk#19): the Worker's own wiring reaches the network.
const PRODUCT = {
  id: 'shytalk',
  name: 'ShyTalk',
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: '["https://shytalk.app"]',
  test_origins_json: '[]',
  monthly_email_share: 100,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
};
async function customer(method: 'GET' | 'POST', url: string, body?: unknown, counted = 1, secret: string | null = 's') {
  const answer: Answer = (sql, values) => {
    if (sql.includes('FROM products')) return values[0] === 'shytalk' ? [PRODUCT] : [];
    if (sql.includes('FROM ticket_types')) return [{ id: 'shytalk:support', name: 'Support', fields_json: '[]' }];
    if (sql.includes('INSERT INTO counters') && String(values[0]).startsWith('contact:')) return [{ value: counted }];
    if (sql.includes('INSERT INTO counters')) return [{ value: 1 }];
    return [];
  };
  const routes = contactRoutes({
    fetcher: () => Promise.resolve(Response.json({ success: true, hostname: 'shytalk.app' })),
    deliver: () => Promise.resolve(),
  });
  const init: RequestInit = { method, headers: { Origin: 'https://shytalk.app', 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const env = {
    DB: standInDb(answer).db,
    ...(secret === null ? {} : { TURNSTILE_SECRET: secret }),
    TICKET_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    TURNSTILE_SITE_KEY: 'k',
    SMTP_LOGINS: '{"no-reply@shytalk.app":{"user":"u","pass":"p"}}',
  };
  const response = await routes.request(url, init, env);
  return { status: response.status, body: (await response.json()) as unknown };
}

async function startUpload(body: unknown, counted: number): Promise<{ status: number; body: unknown }> {
  const answer: Answer = (sql) => {
    if (sql.includes('FROM products')) return [PRODUCT];
    if (sql.includes('window_start')) return [{ value: counted }];
    return [];
  };
  const env = { DB: standInDb(answer).db, FILES: { createMultipartUpload: () => Promise.resolve({ uploadId: 'u' }) } };
  const init = { method: 'POST', headers: { Origin: 'https://shytalk.app' }, body: JSON.stringify(body) };
  const response = await uploadRoutes().request('/support-api/uploads?product=shytalk', init, env);
  return { status: response.status, body: (await response.json()) as unknown };
}

const TICKET = { email: 'a@b.co', subject: 'S', category: 'bug', message: 'M', fields: {}, attachmentIds: [], turnstileToken: 't' };

describe('openapi/shydesk.v1.yaml for the customer API', () => {
  it.each([
    ['the form settings', '/support-api/config?product=shytalk', 200],
    ['an unknown product', '/support-api/config?product=nope', 404],
  ])('the config answer to %s matches the spec', async (_case, url, status) => {
    const answer = await customer('GET', url);
    expect(answer.status).toBe(status);
    expect(check('/support-api/config', 'get', answer.status, answer.body)).toEqual([]);
  });

  it.each([
    ['a new ticket', TICKET, 201, 1],
    ['bad fields', { ...TICKET, email: 'x' }, 400, 1],
    ['an unreadable body', '{', 400, 1],
    ['too many requests', TICKET, 429, 99],
  ])('the tickets answer to %s matches the spec', async (_case, body, status, counted) => {
    const answer = await customer('POST', '/support-api/tickets?product=shytalk', body, counted);
    expect(answer.status).toBe(status);
    expect(check('/support-api/tickets', 'post', answer.status, answer.body)).toEqual([]);
  });

  it.each([
    ['a new upload', { kind: 'video', mime: 'video/mp4', bytes: 5 }, 201, 1],
    ['a type not allowed', { kind: 'video', mime: 'image/svg+xml', bytes: 5 }, 400, 1],
    ['too many starts', { kind: 'video', mime: 'video/mp4', bytes: 5 }, 429, 999],
  ])('the uploads answer to %s matches the spec', async (_case, body, status, counted) => {
    const answer = await startUpload(body, counted);
    expect(answer.status).toBe(status);
    expect(check('/support-api/uploads', 'post', answer.status, answer.body)).toEqual([]);
  });

  it('the tickets answer from a ShyDesk with no Turnstile secret matches the spec', async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      const answer = await customer('POST', '/support-api/tickets?product=shytalk', TICKET, 1, null);
      expect(answer.status).toBe(503);
      expect(check('/support-api/tickets', 'post', answer.status, answer.body)).toEqual([]);
    } finally {
      console.error = original;
    }
  });

  it('the tickets answer to an unknown product matches the spec', async () => {
    const answer = await customer('POST', '/support-api/tickets?product=nope', TICKET);
    expect(answer.status).toBe(404);
    expect(check('/support-api/tickets', 'post', answer.status, answer.body)).toEqual([]);
  });
});

// Appeals (shyden-labs/shydesk#61): each answer of the in-product and the link
// appeal paths matches the status and schema the spec gives it.
const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));
const APPEAL_PRODUCT = {
  id: 'shytalk',
  name: 'ShyTalk',
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: '["https://shytalk.app"]',
  test_origins_json: '[]',
  monthly_email_share: 0,
  attachments_keep_days: 30,
  text_keep_days: 365,
  created_at: 1,
};

async function appealsCall(url: string, init: RequestInit, w: { lifted?: boolean; counted?: number } = {}) {
  const hash = await hashKey(KEY);
  const answer: Answer = (sql, values) => {
    if (sql.includes('FROM api_keys')) return values[0] === hash ? [{ product_id: 'shytalk', revoked_at: null }] : [];
    if (sql.includes('RETURNING value')) return [{ value: w.counted ?? 1 }];
    if (sql.includes('FROM products WHERE id = ?')) return values[0] === 'shytalk' ? [APPEAL_PRODUCT] : [];
    if (sql.includes('FROM punishments p LEFT JOIN appeals')) {
      return values[0] === 'p1' || values[0] === hashOfToken
        ? [{ id: 'p1', product_id: 'shytalk', label: 'Ban', created_at: 2, lifted_at: w.lifted === true ? 3 : null, appealed: 0 }]
        : [];
    }
    return [];
  };
  const response = await app.request(url, init, { DB: standInDb(answer).db, TICKET_TOKEN_KEY: TOKEN_KEY });
  return { status: response.status, body: (await response.json()) as unknown };
}

const hashOfToken = await hashKey('link-token');
const APPEAL = { punishment_id: 'p1', email: 'a@example.com', message: 'Please look again.' };
const keyed = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const fromLink = (token: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: 'https://shytalk.app', 'ShyDesk-Appeal': token, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('openapi/shydesk.v1.yaml for appeals', () => {
  const IN_PRODUCT = '/api/v1/products/{product}/appeals';
  it.each([
    ['an appeal', APPEAL, {}, 201],
    ['a bad body', { punishment_id: 'p1' }, {}, 400],
    ['an unknown punishment', { ...APPEAL, punishment_id: 'nope' }, {}, 404],
    ['a lifted punishment', APPEAL, { lifted: true }, 409],
    ['the 121st appeal in a minute', APPEAL, { counted: 121 }, 429],
  ])('the in-product appeal answer to %s matches the spec', async (_case, body, w, status) => {
    const answer = await appealsCall('/api/v1/products/shytalk/appeals', keyed(body), w);
    expect(answer.status).toBe(status);
    expect(check(IN_PRODUCT, 'post', answer.status, answer.body)).toEqual([]);
  });

  it('the appeal link view matches the spec', async () => {
    const answer = await appealsCall('/support-api/appeals?product=shytalk', fromLink('link-token'), { lifted: true });
    expect(answer.status).toBe(200);
    expect(check('/support-api/appeals', 'get', 200, answer.body)).toEqual([]);
  });

  it('the appeal made from the link matches the spec', async () => {
    const answer = await appealsCall('/support-api/appeals?product=shytalk', fromLink('link-token', APPEAL));
    expect(answer.status).toBe(201);
    expect(check('/support-api/appeals', 'post', 201, answer.body)).toEqual([]);
  });
});
