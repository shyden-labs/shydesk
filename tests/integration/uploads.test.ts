// Upload SQL on a real D1 database with the Release 1 schema (shyden-labs/shydesk#20):
// a 3-part upload stays its own product's, and the running total never passes
// the free storage. The dev-ci token reaches D1 only, so R2 is an in-memory
// stand-in here; real R2 is measured on Non-Prod after the deploy.
import type { R2Bucket } from '@cloudflare/workers-types';
import { describe, expect, inject, it } from 'vitest';
import { saveProduct } from '../../src/products.ts';
import { addStoredWithin, FREE_STORAGE_BYTES, storedBytes } from '../../src/storage.ts';
import { PART_SIZE, uploadRoutes } from '../../src/uploads/routes.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));

async function product(id: string): Promise<void> {
  await saveProduct(
    db,
    {
      id,
      name: id,
      senderAddress: `no-reply@${id}.example`,
      ticketPageUrl: `https://${id}.example/ticket`,
      allowedOrigins: [`https://${id}.example`],
      monthlyEmailShare: 0,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    Date.now(),
  );
}

function memoryBucket(): R2Bucket {
  const objects = new Map<string, Uint8Array>();
  const open = new Map<number, Uint8Array>();
  const multipart = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: (n: number, body: ArrayBuffer) => {
      open.set(n, new Uint8Array(body));
      return Promise.resolve({ partNumber: n, etag: `etag-${String(n)}` });
    },
    complete: () => {
      const chunks = [...open.keys()].sort((a, b) => a - b).map((n) => open.get(n) ?? new Uint8Array());
      const whole = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        whole.set(c, at);
        at += c.length;
      }
      objects.set(key, whole);
      return Promise.resolve({ key });
    },
  });
  return {
    createMultipartUpload: (key: string) => Promise.resolve(multipart(key, 'one-upload')),
    resumeMultipartUpload: multipart,
    head: (key: string) => Promise.resolve(objects.has(key) ? { size: objects.get(key)?.length } : null),
    get: (key: string, { range }: { range: { offset: number; length: number } }) => {
      const slice = (objects.get(key) ?? new Uint8Array()).slice(range.offset, range.offset + range.length);
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(slice.buffer) });
    },
  } as unknown as R2Bucket;
}

describe('uploads on D1', () => {
  it('completes a 3-part upload of the right size, and another product can touch none of it', async () => {
    await product('it-up');
    await product('it-up-other');
    const FILES = memoryBucket();
    const app = uploadRoutes();
    const call = (productId: string, path: string, init: RequestInit) =>
      app.request(
        `/support-api/uploads${path}?product=${productId}`,
        {
          ...init,
          headers: {
            Origin: `https://${productId}.example`,
            'CF-Connecting-IP': '203.0.113.20',
            ...(init.headers as Record<string, string> | undefined),
          },
        },
        { DB: db, FILES },
      );
    const part = (productId: string, id: string, n: number, bytes: Uint8Array) =>
      call(productId, `/${id}/parts/${String(n)}`, {
        method: 'PUT',
        body: bytes as unknown as BodyInit,
        headers: { 'Content-Length': String(bytes.length) },
      });

    const size = PART_SIZE * 2 + 5;
    const started = await call('it-up', '', { method: 'POST', body: JSON.stringify({ kind: 'image', mime: 'image/jpeg', bytes: size }) });
    expect(started.status).toBe(201);
    const { id, parts } = (await started.json()) as { id: string; parts: number };
    expect(parts).toBe(3);

    const first = new Uint8Array(PART_SIZE);
    first.set([0xff, 0xd8, 0xff]);
    expect.soft((await part('it-up-other', id, 1, first)).status).toBe(404);
    expect.soft((await part('it-up', id, 1, first)).status).toBe(200);
    expect.soft((await part('it-up', id, 2, new Uint8Array(PART_SIZE))).status).toBe(200);
    expect.soft((await part('it-up', id, 3, new Uint8Array(5))).status).toBe(200);

    const etags = JSON.stringify({ parts: [1, 2, 3].map((n) => ({ n, etag: `etag-${String(n)}` })) });
    expect.soft((await call('it-up-other', `/${id}/complete`, { method: 'POST', body: etags })).status).toBe(404);
    const before = await storedBytes(db);
    expect.soft((await call('it-up', `/${id}/complete`, { method: 'POST', body: etags })).status).toBe(200);

    const row = await db.prepare('SELECT state, bytes FROM attachments WHERE id = ?').bind(id).first();
    expect.soft(row).toEqual({ state: 'stored', bytes: size });
    expect.soft(await storedBytes(db)).toBeGreaterThanOrEqual(before + size);
  });

  it('adds to the running total only while it stays within the free storage', async () => {
    expect.soft(await addStoredWithin(db, 1)).toBe(true);
    const before = await storedBytes(db);
    expect.soft(await addStoredWithin(db, FREE_STORAGE_BYTES)).toBe(false);
    expect.soft(await storedBytes(db)).toBe(before);
  });
});
