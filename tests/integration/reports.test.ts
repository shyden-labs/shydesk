// The reports API on a real D1 database (shyden-labs/shydesk#59; Release 2 plan
// Task 3): a report sent through the API is read back through it, with the
// subject's earlier report of the same product in its history and nothing from
// another product; an upload grant counts down in SQL and stops at its last file.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { apiRoutes } from '../../src/api/routes.ts';
import { createApiKey, saveProduct, saveReportReasons } from '../../src/products.ts';
import { createGrant, grantLive, useGrant } from '../../src/reports/grants.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const app = apiRoutes();

async function product(id: string): Promise<string> {
  await saveProduct(
    db,
    {
      id,
      name: `Product ${id}`,
      senderAddress: `no-reply@${id}.example`,
      ticketPageUrl: `https://${id}.example/ticket`,
      allowedOrigins: [`https://${id}.example`],
      monthlyEmailShare: 100,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    1000,
  );
  await saveReportReasons(db, id, ['Cheating', 'Harassment']);
  return createApiKey(db, id, 'reports test', 1000);
}

const send = async (method: string, path: string, key: string, body?: unknown) => {
  const response = await app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB: db },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const report = (reason: string, itemId: string) => ({
  reporter_id: 'reporter-1',
  item: { kind: 'message', id: itemId },
  subject_user_id: 'subject-1',
  reason,
});

// Each product takes about 2 s to set up over D1's REST API (measured on CI run
// 43802312471), so all are made once here, under the hook's limit, and each test
// stays inside the 10 s test limit.
const keys: Record<string, string> = {};
beforeAll(async () => {
  for (const id of ['it-rep-a', 'it-rep-b', 'it-rep-c', 'it-rep-d', 'it-rep-e']) keys[id] = await product(id);
});
const keyOf = (id: string): string => keys[id] ?? '';

describe('reports', () => {
  it("reads a report back with the subject's earlier report in this product only", async () => {
    const keyA = keyOf('it-rep-a');
    const keyB = keyOf('it-rep-b');
    const earlier = await send('POST', '/api/v1/products/it-rep-a/reports', keyA, report('Cheating', 'm1'));
    expect(earlier.status).toBe(202);
    // The same subject id reported in another product must not show in this product's history.
    expect((await send('POST', '/api/v1/products/it-rep-b/reports', keyB, report('Cheating', 'm2'))).status).toBe(202);
    const sent = await send('POST', '/api/v1/products/it-rep-a/reports', keyA, { ...report('Harassment', 'm3'), note: 'Again.' });
    expect(sent.status).toBe(202);

    const read = await send('GET', `/api/v1/products/it-rep-a/reports/${String(sent.body.report_id)}`, keyA);
    expect(read.status).toBe(200);
    expect.soft(read.body.report).toMatchObject({
      id: sent.body.report_id,
      status: 'open',
      reporter_id: 'reporter-1',
      item: { kind: 'message', id: 'm3' },
      subject_user_id: 'subject-1',
      reason: 'Harassment',
      note: 'Again.',
      context: {},
    });
    const history = read.body.history as { reports: Record<string, unknown>[]; punishments: unknown[] };
    expect
      .soft(history.reports.map(({ created_at: _at, ...rest }) => rest))
      .toEqual([{ ticket_id: earlier.body.report_id, reason: 'Cheating', status: 'open' }]);
    expect.soft(typeof history.reports[0]?.created_at).toBe('number');
    expect.soft(history.punishments).toEqual([]);
  });

  it("answers 404 for another product's report read with that product's key", async () => {
    const keyC = keyOf('it-rep-c');
    const keyD = keyOf('it-rep-d');
    const sent = await send('POST', '/api/v1/products/it-rep-c/reports', keyC, report('Cheating', 'm4'));
    expect((await send('GET', `/api/v1/products/it-rep-d/reports/${String(sent.body.report_id)}`, keyD)).status).toBe(404);
  });

  it('refuses a reason the product does not list', async () => {
    const key = keyOf('it-rep-e');
    const answer = await send('POST', '/api/v1/products/it-rep-e/reports', key, report('Spam', 'm5'));
    expect(answer).toEqual({ status: 422, body: { error: 'unknown_reason' } });
  });
});

describe('upload grants', () => {
  it('counts a grant down to its last file and then refuses it, for its own product only', async () => {
    await product('it-grant-a');
    const now = Date.now();
    const { grant } = await createGrant(db, 'it-grant-a', 2, now);
    await expect(useGrant(db, 'it-grant-b', grant, now)).resolves.toBe(false);
    await expect(useGrant(db, 'it-grant-a', grant, now)).resolves.toBe(true);
    await expect(useGrant(db, 'it-grant-a', grant, now)).resolves.toBe(true);
    await expect(useGrant(db, 'it-grant-a', grant, now)).resolves.toBe(false);
    await expect(grantLive(db, 'it-grant-a', grant, now)).resolves.toBe(true);
    await expect(grantLive(db, 'it-grant-a', grant, now + 15 * 60 * 1000)).resolves.toBe(false);
  });
});
