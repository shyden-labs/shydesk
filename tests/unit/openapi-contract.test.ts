import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { app } from '../../src/index.ts';
import { hashKey } from '../../src/products.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// The hand-written spec, openapi/shydesk.v1.yaml, is the contract product
// servers and the shared piece code against (shyden-labs/shydesk#26). Every
// route the Worker registers under /api/v1 and /support-api is in it, every
// path in it is registered, and every response the Worker gives validates
// against the schema the spec documents for that status.
interface Operation {
  responses: Record<string, { content?: { 'application/json'?: { schema: unknown } } }>;
}
interface Spec {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
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
  const response = spec.paths[path]?.[method]?.responses[String(status)];
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
  return { status: response.status, body: await response.json() };
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
