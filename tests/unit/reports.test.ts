import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { apiRoutes } from '../../src/api/routes.ts';
import { hashKey } from '../../src/products.ts';
import { createReport } from '../../src/reports/create.ts';
import { offenderHistory } from '../../src/reports/history.ts';
import { standInDb, type Answer, type Statement } from './d1-stand-in.ts';

// The reports API (shyden-labs/shydesk#59; Release 2 plan Task 3). The product's
// server, never its app, sends a report with its product key. ShyDesk takes
// `reporter_id` as the server asserts it. Evidence goes up from the app under an
// upload grant the server asked for. A report's history is that product's only.

const SHYTALK_KEY = 'shytalk-key';
const YAWELO_KEY = 'yawelo-key';

interface World {
  /** What the reports rate counter reads after this request. */
  counted?: number;
  /** Stored, unattached uploads and the product each belongs to. */
  uploads?: Record<string, string>;
  /** The stored report a GET reads, by product. */
  report?: { product: string; row: Record<string, unknown> };
  history?: { reports: Record<string, unknown>[]; punishments: Record<string, unknown>[] };
  /** The database refuses every batch, as when D1 is down. */
  batchFails?: boolean;
}

async function setup(w: World = {}) {
  const keys = new Map([
    [await hashKey(SHYTALK_KEY), 'shytalk'],
    [await hashKey(YAWELO_KEY), 'yawelo-idle'],
  ]);
  const answer: Answer = (sql, values) => {
    if (sql.includes('FROM api_keys')) {
      const product = keys.get(String(values[0]));
      return product ? [{ product_id: product, revoked_at: null }] : [];
    }
    if (sql.includes('RETURNING value') && String(values[0]).startsWith('reports:')) return [{ value: w.counted ?? 1 }];
    if (sql.includes('FROM ticket_types')) return values[0] === 'shytalk:report' ? [{ reasons_json: '["Cheating","Harassment"]' }] : [];
    if (sql.includes('FROM attachments WHERE id IN')) {
      const product = values.at(-1);
      return values.slice(0, -1).flatMap((id) => (w.uploads?.[String(id)] === product ? [{ id }] : []));
    }
    if (sql.includes('FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.ticket_id = ?')) {
      return w.report && values[0] === w.report.row.id && values[1] === w.report.product ? [w.report.row] : [];
    }
    if (sql.includes('FROM reports r JOIN tickets t')) return w.history?.reports ?? [];
    if (sql.includes('FROM punishments')) return w.history?.punishments ?? [];
    return [];
  };
  const stood = standInDb(answer);
  const statements = stood.statements;
  const db: D1Database = w.batchFails
    ? ({ prepare: (sql: string) => stood.db.prepare(sql), batch: () => Promise.reject(new Error('D1 is down')) } as unknown as D1Database)
    : stood.db;
  const app = apiRoutes();
  const send = (method: string, path: string, key: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      },
      { DB: db },
    );
  return { send, statements };
}

const REPORT = {
  reporter_id: 'user-1',
  item: { kind: 'message', id: 'msg-9' },
  subject_user_id: 'user-2',
  reason: 'Harassment',
  note: 'Said this three times.',
  context: { room: 'lobby' },
};

const inserts = (statements: Statement[], table: string) => statements.filter((s) => new RegExp(`^\\s*INSERT INTO ${table} `).test(s.sql));

describe('POST /api/v1/products/{product}/reports', () => {
  it('takes a valid report with 202 and writes one report ticket and one reports row', async () => {
    const { send, statements } = await setup();
    const response = await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, REPORT);
    expect(response.status).toBe(202);
    const { report_id } = (await response.json()) as { report_id: string };
    expect(report_id).toMatch(/^[0-9a-f-]{36}$/);
    const tickets = inserts(statements, 'tickets');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.method).toBe('batch');
    // id, product, type, email (none), subject, category, fields, token hash, created, updated
    expect(tickets[0]?.values.slice(0, 7)).toEqual([
      report_id,
      'shytalk',
      'shytalk:report',
      '',
      'Harassment: message msg-9',
      'Harassment',
      '{}',
    ]);
    const reports = inserts(statements, 'reports');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.values).toEqual([report_id, 'shytalk', 'user-1', 'message', 'msg-9', 'user-2', 'Harassment', '{"room":"lobby"}']);
    expect(inserts(statements, 'messages')[0]?.values.slice(1, 3)).toEqual([report_id, 'Said this three times.']);
  });

  it('sends no email, since a report has no customer address', async () => {
    const { send, statements } = await setup();
    await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, REPORT);
    expect(statements.some((s) => /monthly_email_share|email:/.test(s.sql))).toBe(false);
  });

  it('puts stored uploads of this product on the report', async () => {
    const { send, statements } = await setup({ uploads: { u1: 'shytalk', u2: 'shytalk' } });
    const response = await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, { ...REPORT, upload_ids: ['u1', 'u2'] });
    expect(response.status).toBe(202);
    const attach = statements.find((s) => /^UPDATE attachments SET ticket_id = \?/.test(s.sql));
    expect(attach?.method).toBe('batch');
    expect(attach?.values.slice(2)).toEqual(['u1', 'u2', 'shytalk']);
  });

  it('refuses an unknown reason with 422 unknown_reason and writes nothing', async () => {
    const { send, statements } = await setup();
    const response = await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, { ...REPORT, reason: 'Bad vibes' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'unknown_reason' });
    expect(inserts(statements, 'tickets')).toEqual([]);
  });

  it("refuses an upload from another product's grant with 422 unknown_upload", async () => {
    const { send, statements } = await setup({ uploads: { u1: 'yawelo-idle' } });
    const response = await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, { ...REPORT, upload_ids: ['u1'] });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'unknown_upload' });
    expect(inserts(statements, 'tickets')).toEqual([]);
  });

  it('refuses more than 10 uploads as a bad request', async () => {
    const { send } = await setup();
    const ids = Array.from({ length: 11 }, (_, i) => `u${String(i)}`);
    expect((await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, { ...REPORT, upload_ids: ids })).status).toBe(400);
  });

  it('answers a yawelo-idle key on /products/shytalk/reports with 404', async () => {
    const { send, statements } = await setup();
    const response = await send('POST', '/api/v1/products/shytalk/reports', YAWELO_KEY, REPORT);
    expect(response.status).toBe(404);
    expect(inserts(statements, 'tickets')).toEqual([]);
  });

  it('answers the 120th report in a minute, and refuses the 121st with 429 rate_limited', async () => {
    const at120 = await setup({ counted: 120 });
    expect((await at120.send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, REPORT)).status).toBe(202);
    const at121 = await setup({ counted: 121 });
    const response = await at121.send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, REPORT);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expect(inserts(at121.statements, 'tickets')).toEqual([]);
  });

  it("counts reports per product, per minute, on the product's own key", async () => {
    const { send, statements } = await setup();
    await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, REPORT);
    const count = statements.find((s) => s.sql.includes('RETURNING value') && s.values[0] === 'reports:shytalk');
    expect(count?.values).toEqual(['reports:shytalk', expect.any(Number), expect.any(Number)]);
    expect(Number(count?.values[1]) - Number(count?.values[2])).toBe(60_000);
  });

  it.each([
    ['not JSON', '{'],
    ['no reporter', { ...REPORT, reporter_id: '' }],
    ['no item id', { ...REPORT, item: { kind: 'message' } }],
    ['an item that is not an object', { ...REPORT, item: 'msg-9' }],
    ['no subject user', { ...REPORT, subject_user_id: undefined }],
    ['a reporter id of 201 characters', { ...REPORT, reporter_id: 'x'.repeat(201) }],
    ['a note of 5001 characters', { ...REPORT, note: 'x'.repeat(5001) }],
    ['a context that is a list', { ...REPORT, context: ['lobby'] }],
    ['a context over 16000 characters', { ...REPORT, context: { big: 'x'.repeat(16_000) } }],
    ['upload ids that are not text', { ...REPORT, upload_ids: [1] }],
  ])('refuses %s with 400 bad_request', async (_case, body) => {
    const { send, statements } = await setup();
    const response = await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request' });
    expect(inserts(statements, 'tickets')).toEqual([]);
  });

  it('takes a report with no note, context or uploads, storing an empty context', async () => {
    const { send, statements } = await setup();
    const { note: _note, context: _context, ...bare } = REPORT;
    expect((await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, bare)).status).toBe(202);
    expect(inserts(statements, 'reports')[0]?.values.at(-1)).toBe('{}');
    expect(inserts(statements, 'messages')[0]?.values[2]).toBe('');
  });
});

describe('POST /api/v1/products/{product}/upload-grants', () => {
  it('returns 201 with a grant and when it expires', async () => {
    const { send, statements } = await setup();
    const response = await send('POST', '/api/v1/products/shytalk/upload-grants', SHYTALK_KEY, { count: 3 });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { grant: string; expires_at: number };
    expect(body.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statements.find((s) => /INSERT INTO counters/.test(s.sql) && String(s.values[0]).startsWith('grant:shytalk:'))?.values[1]).toBe(
      3,
    );
  });

  it.each([0, 11, 2.5, '3'])('refuses a count of %s with 400', async (count) => {
    const { send } = await setup();
    expect((await send('POST', '/api/v1/products/shytalk/upload-grants', SHYTALK_KEY, { count })).status).toBe(400);
  });

  it("answers another product's key with 404", async () => {
    const { send } = await setup();
    expect((await send('POST', '/api/v1/products/shytalk/upload-grants', YAWELO_KEY, { count: 1 })).status).toBe(404);
  });
});

const STORED = {
  id: 'r1',
  status: 'open',
  created_at: 5,
  reporter_id: 'user-1',
  item_kind: 'message',
  item_id: 'msg-9',
  subject_user_id: 'user-2',
  reason: 'Harassment',
  context_json: '{"room":"lobby"}',
  note: 'Said this three times.',
};

describe('GET /api/v1/products/{product}/reports/{id}', () => {
  it('returns the report and its history', async () => {
    const history = {
      reports: [{ ticket_id: 'r0', reason: 'Cheating', created_at: 1, status: 'closed' }],
      punishments: [{ id: 'p1', label: 'Ban 7 days', created_at: 2, send_state: 'applied', lifted_at: null }],
    };
    const { send } = await setup({ report: { product: 'shytalk', row: STORED }, history });
    const response = await send('GET', '/api/v1/products/shytalk/reports/r1', SHYTALK_KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      report: {
        id: 'r1',
        status: 'open',
        created_at: 5,
        reporter_id: 'user-1',
        item: { kind: 'message', id: 'msg-9' },
        subject_user_id: 'user-2',
        reason: 'Harassment',
        note: 'Said this three times.',
        context: { room: 'lobby' },
      },
      history,
    });
  });

  it('gives a report sent with no note a null note', async () => {
    const { send } = await setup({ report: { product: 'shytalk', row: { ...STORED, note: '' } } });
    const body = (await (await send('GET', '/api/v1/products/shytalk/reports/r1', SHYTALK_KEY)).json()) as { report: { note: unknown } };
    expect(body.report.note).toBeNull();
  });

  it("answers 404 for another product's report, read with that product's own key", async () => {
    const { send } = await setup({ report: { product: 'shytalk', row: STORED } });
    const response = await send('GET', '/api/v1/products/yawelo-idle/reports/r1', YAWELO_KEY);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('answers 404 for a report that does not exist', async () => {
    const { send } = await setup();
    expect((await send('GET', '/api/v1/products/shytalk/reports/nope', SHYTALK_KEY)).status).toBe(404);
  });
});

describe('offenderHistory', () => {
  it('binds the product id in both queries, filters it in SQL, newest first, 50 of each', async () => {
    const { db, statements } = standInDb(() => []);
    await offenderHistory(db, 'shytalk', 'user-2', 'r1');
    const [reports, punishments] = statements;
    expect.soft(reports?.sql).toMatch(/WHERE r\.product_id = \? AND r\.subject_user_id = \? AND r\.ticket_id != \?/);
    expect.soft(reports?.sql).toMatch(/ORDER BY t\.created_at DESC LIMIT 50/);
    expect.soft(reports?.values).toEqual(['shytalk', 'user-2', 'r1']);
    expect
      .soft(punishments?.sql)
      .toMatch(/FROM punishments WHERE product_id = \? AND subject_user_id = \? ORDER BY created_at DESC LIMIT 50/);
    expect.soft(punishments?.values).toEqual(['shytalk', 'user-2']);
  });

  it('excludes nothing when no ticket is named', async () => {
    const { db, statements } = standInDb(() => []);
    await offenderHistory(db, 'shytalk', 'user-2');
    expect(statements[0]?.values).toEqual(['shytalk', 'user-2', '']);
  });
});

describe('failures and edges (shyden-labs/shydesk#59)', () => {
  it('refuses a report on a product with no report reasons set, as an unknown reason', async () => {
    const { send } = await setup();
    const response = await send('POST', '/api/v1/products/yawelo-idle/reports', YAWELO_KEY, REPORT);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'unknown_reason' });
  });

  it('answers 500 when the database fails, rather than saying the report was received', async () => {
    const { send } = await setup({ batchFails: true });
    expect((await send('POST', '/api/v1/products/shytalk/reports', SHYTALK_KEY, REPORT)).status).toBe(500);
  });

  it('passes on a database failure while checking uploads, rather than calling them unknown', async () => {
    const { db } = standInDb((sql) => {
      if (sql.includes('FROM ticket_types')) return [{ reasons_json: '["Harassment"]' }];
      if (sql.includes('FROM attachments')) throw new Error('D1 is down');
      return [];
    });
    const report = { ...REPORT, note: '', context: {}, upload_ids: ['u1'] };
    await expect(createReport(db, 'shytalk', report)).rejects.toThrow('D1 is down');
  });

  it('refuses an upload grant body that is not JSON with 400', async () => {
    const { send } = await setup();
    expect((await send('POST', '/api/v1/products/shytalk/upload-grants', SHYTALK_KEY, '{')).status).toBe(400);
  });
});
