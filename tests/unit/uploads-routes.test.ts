import { readFileSync } from 'node:fs';
import type { R2Bucket } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../src/customer/messages.ts';
import { FREE_STORAGE_BYTES } from '../../src/storage.ts';
import { PART_SIZE, uploadRoutes } from '../../src/uploads/routes.ts';
import { standInDb } from './d1-stand-in.ts';

// Uploads go straight from the browser to ShyDesk in parts of at most 8 MB, and
// the server decides what it keeps by content (shyden-labs/shydesk#20).
const ORIGIN = 'https://shytalk.app';
const THIRTY_DAYS = 30;
const product = (id: string) => ({
  id,
  name: id,
  sender_address: 'no-reply@shytalk.app',
  ticket_page_url: 'https://shytalk.app/support/ticket',
  allowed_origins_json: JSON.stringify([ORIGIN]),
  monthly_email_share: 100,
  attachments_keep_days: THIRTY_DAYS,
  text_keep_days: 365,
  created_at: 1,
});

interface Row {
  id: string;
  product_id: string;
  r2_key: string;
  r2_upload_id: string | null;
  thumb_key: string;
  mime: string;
  bytes: number;
  received_bytes: number;
  ticket_id?: string | null;
  duration_ms: number | null;
  state: string;
  created_at: number;
  deleted_at: number | null;
}

/** An R2 bucket in memory, keeping what a test asserts: objects, open uploads and aborted ones. */
function standInBucket() {
  const objects = new Map<string, Uint8Array>();
  const open = new Map<string, Map<number, Uint8Array>>();
  const aborted: string[] = [];
  const deleted: string[] = [];
  const state = { vanishOnRead: false, headThrows: false, deleteThrows: false };
  let next = 0;
  const handle = (key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart: (n: number, body: ArrayBuffer) => {
      open.get(uploadId)?.set(n, new Uint8Array(body));
      return Promise.resolve({ partNumber: n, etag: `etag-${String(n)}` });
    },
    abort: () => {
      if (uploadId === 'gone') return Promise.reject(new Error('no such upload'));
      aborted.push(uploadId);
      open.delete(uploadId);
      return Promise.resolve();
    },
    complete: (parts: { partNumber: number; etag: string }[]) => {
      const held = open.get(uploadId);
      if (!held) return Promise.reject(new Error('no such upload'));
      const chunks = parts.map((p) => {
        const chunk = held.get(p.partNumber);
        if (!chunk || p.etag !== `etag-${String(p.partNumber)}`) throw new Error('bad part');
        return chunk;
      });
      const whole = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        whole.set(c, at);
        at += c.length;
      }
      objects.set(key, whole);
      open.delete(uploadId);
      return Promise.resolve({ key });
    },
  });
  const bucket = {
    createMultipartUpload: (key: string) => {
      next += 1;
      const uploadId = `upload-${String(next)}`;
      open.set(uploadId, new Map());
      return Promise.resolve(handle(key, uploadId));
    },
    resumeMultipartUpload: (key: string, uploadId: string) => handle(key, uploadId),
    head: (key: string) => {
      if (state.headThrows) return Promise.reject(new Error('R2 is down'));
      const found = objects.get(key);
      return Promise.resolve(found ? { size: found.length } : null);
    },
    get: (key: string, options: { range: { offset: number; length: number } }) => {
      const found = objects.get(key);
      if (!found || state.vanishOnRead) return Promise.resolve(null);
      const { offset, length } = options.range;
      const slice = found.slice(offset, offset + length);
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(slice.buffer) });
    },
    put: (key: string, body: ArrayBuffer) => {
      objects.set(key, new Uint8Array(body));
      return Promise.resolve({ key });
    },
    delete: (keys: string | string[]) => {
      if (state.deleteThrows) return Promise.reject(new Error('R2 is down'));
      for (const key of [keys].flat()) {
        deleted.push(key);
        objects.delete(key);
      }
      return Promise.resolve();
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects, open, aborted, deleted, state };
}

interface Options {
  stored?: number;
  /** What the rate-limit counter reads for a key: the request is admitted while it is within the limit. */
  counted?: Record<string, number>;
  rows?: Row[];
}

function world(options: Options = {}) {
  const rows = new Map<string, Row>((options.rows ?? []).map((r) => [r.id, r]));
  const counters = { stored: options.stored ?? 0 };
  const statementsAnswering = { claimLost: false };
  const { db, statements } = standInDb((sql, v) => {
    if (sql.includes('FROM products')) return ['shytalk', 'other'].includes(String(v[0])) ? [product(String(v[0]))] : [];
    if (sql.includes('SELECT value FROM counters')) return [{ value: counters.stored }];
    if (sql.includes('window_start')) return [{ value: options.counted?.[String(v[0])] ?? 1 }];
    if (sql.includes('INSERT INTO counters')) {
      const n = Number(v[1]);
      if (counters.stored + n > FREE_STORAGE_BYTES) return [];
      counters.stored += n;
      return [{ value: counters.stored }];
    }
    if (sql.includes('UPDATE counters SET value = value -')) {
      counters.stored -= Number(v[0]);
      return [];
    }
    if (sql.includes('INSERT INTO attachments')) {
      const [id, product_id, r2_key, r2_upload_id, thumb_key, mime, bytes, created_at] = v as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      rows.set(id, {
        id,
        product_id,
        r2_key,
        r2_upload_id,
        thumb_key,
        mime,
        bytes,
        received_bytes: 0,
        ticket_id: null,
        duration_ms: null,
        state: 'pending',
        created_at,
        deleted_at: null,
      });
      return [];
    }
    if (sql.includes('SET r2_upload_id = NULL') && sql.includes('RETURNING')) {
      const row = rows.get(String(v[0]));
      if (statementsAnswering.claimLost || !row) return [];
      if (row.product_id !== v[1] || row.state !== 'pending' || row.r2_upload_id === null) return [];
      row.r2_upload_id = null;
      return [{ ...row }];
    }
    if (sql.includes('received_bytes = received_bytes +')) {
      const row = rows.get(String(v[1]));
      if (row) row.received_bytes += Number(v[0]);
      return [];
    }
    if (sql.includes('UPDATE attachments') && sql.includes("state = 'stored'") && sql.includes('duration_ms')) {
      const row = rows.get(String(v[2]));
      if (row) Object.assign(row, { mime: v[0], duration_ms: v[1], state: 'stored' });
      return [];
    }
    if (sql.includes('UPDATE attachments') && sql.includes('bytes = bytes +')) {
      const row = rows.get(String(v[1]));
      if (row) row.bytes += Number(v[0]);
      return [];
    }
    if (sql.includes('UPDATE attachments') && sql.includes("state = 'deleted'")) {
      const row = rows.get(String(v[1]));
      if (row) Object.assign(row, { state: 'deleted', deleted_at: v[0] });
      return [];
    }
    if (sql.includes('FROM attachments') && sql.includes('thumb_key = ?')) {
      return [...rows.values()].filter((r) => r.thumb_key === v[0] && r.product_id === v[1] && r.state === 'stored') as unknown as Record<
        string,
        unknown
      >[];
    }
    if (sql.includes('FROM attachments') && sql.includes('ticket_id IS NULL')) {
      return [...rows.values()].filter((r) => r.state === 'stored' && !r.ticket_id && r.created_at < Number(v[0])) as unknown as Record<
        string,
        unknown
      >[];
    }
    if (sql.includes('FROM attachments') && sql.includes('created_at <')) {
      return [...rows.values()].filter((r) => r.state === 'pending' && r.created_at < Number(v[0])) as unknown as Record<string, unknown>[];
    }
    if (sql.includes('FROM attachments')) {
      return [...rows.values()]
        .filter((r) => r.id === v[0] && r.product_id === v[1] && r.state === 'pending' && r.r2_upload_id !== null)
        .map((r) => ({ ...r }));
    }
    return [];
  });
  const r2 = standInBucket();
  const app = uploadRoutes();
  const call = (path: string, init: RequestInit = {}, productId = 'shytalk') =>
    app.request(
      `${path}?product=${productId}`,
      { ...init, headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9', ...(init.headers as Record<string, string> | undefined) } },
      { DB: db, FILES: r2.bucket },
    );
  const start = (body: unknown, productId = 'shytalk') =>
    call(
      '/support-api/uploads',
      { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
      productId,
    );
  const put = (path: string, bytes: Uint8Array, productId = 'shytalk', length = bytes.length) =>
    call(path, { method: 'PUT', body: bytes as unknown as BodyInit, headers: { 'Content-Length': String(length) } }, productId);
  const complete = (id: string, parts: unknown, productId = 'shytalk') =>
    call(`/support-api/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify({ parts }) }, productId);
  /** Starts an upload of these bytes, sends them in one part and completes it. */
  const uploadWhole = async (kind: string, mime: string, bytes: Uint8Array) => {
    const started = (await (await start({ kind, mime, bytes: bytes.length })).json()) as { id: string; thumbId: string };
    await put(`/support-api/uploads/${started.id}/parts/1`, bytes);
    return { ...started, response: await complete(started.id, [{ n: 1, etag: 'etag-1' }]) };
  };
  return { call, start, put, complete, uploadWhole, rows, counters, r2, statements, statementsAnswering };
}

const fixture = (path: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/${path}`, import.meta.url)));
const VIDEO = { kind: 'video', mime: 'video/mp4' };
const MB300 = 300 * 1024 * 1024;

describe('starting an upload', () => {
  it('answers the upload id, part size, part count and thumbnail id', async () => {
    const w = world();
    const response = await w.start({ ...VIDEO, bytes: PART_SIZE + 1 });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ id: expect.any(String) as unknown, partSize: 8_388_608, parts: 2, thumbId: expect.any(String) as unknown });
    expect(w.r2.open.size).toBe(1);
    expect(w.rows.get(String(body.id))).toMatchObject({
      product_id: 'shytalk',
      state: 'pending',
      bytes: PART_SIZE + 1,
      r2_upload_id: 'upload-1',
    });
  });

  it('accepts a 300 MB video in 38 parts when storage has room: no per-file size limit', async () => {
    const response = await world().start({ ...VIDEO, bytes: MB300 });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { parts: number }).parts).toBe(38);
  });

  it('refuses a start that would pass the free storage, before any part', async () => {
    const w = world({ stored: FREE_STORAGE_BYTES - 10 });
    const response = await w.start({ ...VIDEO, bytes: 11 });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.storageFull });
    expect(w.r2.open.size).toBe(0);
    expect(w.rows.size).toBe(0);
  });

  it('accepts a start that exactly fills the free storage', async () => {
    const response = await world({ stored: FREE_STORAGE_BYTES - 10 }).start({ ...VIDEO, bytes: 10 });
    expect(response.status).toBe(201);
  });

  it.each([
    ['a zero size', { ...VIDEO, bytes: 0 }],
    ['a negative size', { ...VIDEO, bytes: -1 }],
    ['a fractional size', { ...VIDEO, bytes: 1.5 }],
    ['a size that is not a number', { ...VIDEO, bytes: '5' }],
    ['an unknown kind', { kind: 'audio', mime: 'video/mp4', bytes: 5 }],
    ['an image named as MP4', { kind: 'image', mime: 'video/mp4', bytes: 5 }],
    ['a video named as JPEG', { kind: 'video', mime: 'image/jpeg', bytes: 5 }],
    ['a type not allowed', { kind: 'image', mime: 'image/svg+xml', bytes: 5 }],
    ['a body that is not an object', []],
  ])('refuses %s', async (_name, body) => {
    const w = world();
    expect((await w.start(body)).status).toBe(400);
    expect(w.r2.open.size).toBe(0);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await world().call('/support-api/uploads', { method: 'POST', body: 'nope' });
    expect(response.status).toBe(400);
  });

  it('admits the 30th start in an hour from one client IP', async () => {
    const w = world({ counted: { 'upload-ip:203.0.113.9': 30 } });
    expect((await w.start({ ...VIDEO, bytes: 5 })).status).toBe(201);
  });

  it('refuses the 31st start in an hour from one client IP', async () => {
    const w = world({ counted: { 'upload-ip:203.0.113.9': 31 } });
    const response = await w.start({ ...VIDEO, bytes: 5 });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: MESSAGES.tooMany });
    expect(w.r2.open.size).toBe(0);
  });

  it('admits the 300th start in an hour for one product', async () => {
    const w = world({ counted: { 'upload-product:shytalk': 300 } });
    expect((await w.start({ ...VIDEO, bytes: 5 })).status).toBe(201);
  });

  it('refuses the 301st start in an hour for one product', async () => {
    const w = world({ counted: { 'upload-product:shytalk': 301 } });
    expect((await w.start({ ...VIDEO, bytes: 5 })).status).toBe(429);
  });

  it('does not spend the product count on an IP already over its limit', async () => {
    const w = world({ counted: { 'upload-ip:203.0.113.9': 31 } });
    await w.start({ ...VIDEO, bytes: 5 });
    expect(w.statements.some((s) => s.values[0] === 'upload-product:shytalk')).toBe(false);
  });

  const old = (over: Partial<Row>): Row => ({
    id: 'old',
    product_id: 'other',
    r2_key: 'old-key',
    r2_upload_id: 'stale-upload',
    thumb_key: 'old-thumb',
    mime: 'video/mp4',
    bytes: 50,
    received_bytes: 0,
    ticket_id: null,
    duration_ms: null,
    state: 'pending',
    created_at: 0,
    deleted_at: null,
    ...over,
  });

  it("aborts any product's upload still pending after an hour, giving back the bytes it received", async () => {
    const w = world({ rows: [old({ received_bytes: 20 })], stored: 20 });
    await w.start({ ...VIDEO, bytes: 5 });
    expect(w.r2.aborted).toEqual(['stale-upload']);
    expect(w.rows.get('old')?.state).toBe('deleted');
    expect(w.counters.stored).toBe(0);
  });

  it('deletes the object of an old upload stopped part way through finishing', async () => {
    const w = world({ rows: [old({ r2_upload_id: null, received_bytes: 20 })], stored: 20 });
    w.r2.objects.set('old-key', new Uint8Array(20));
    await w.start({ ...VIDEO, bytes: 5 });
    expect(w.r2.aborted).toEqual([]);
    expect(w.r2.objects.has('old-key')).toBe(false);
    expect(w.rows.get('old')?.state).toBe('deleted');
    expect(w.counters.stored).toBe(0);
  });

  it("expires any product's finished upload never put on a ticket after a day, with its thumbnail and bytes", async () => {
    const w = world({ rows: [old({ state: 'stored', r2_upload_id: null, bytes: 50 })], stored: 50 });
    w.r2.objects.set('old-key', new Uint8Array(45));
    w.r2.objects.set('old-thumb', new Uint8Array(5));
    await w.start({ ...VIDEO, bytes: 5 });
    expect(w.r2.objects.size).toBe(0);
    expect(w.rows.get('old')?.state).toBe('deleted');
    expect(w.counters.stored).toBe(0);
  });

  it('still starts when expiring an old upload fails, leaving that one stored for the admin desk to list', async () => {
    const w = world({ rows: [old({ state: 'stored', r2_upload_id: null })], stored: 50 });
    w.r2.state.deleteThrows = true;
    expect((await w.start({ ...VIDEO, bytes: 5 })).status).toBe(201);
    expect(w.rows.get('old')?.state).toBe('stored');
  });

  it('keeps a finished upload not on a ticket for under a day', async () => {
    const w = world({ rows: [old({ state: 'stored', r2_upload_id: null, created_at: Date.now() - 3_600_000 })], stored: 50 });
    await w.start({ ...VIDEO, bytes: 5 });
    expect(w.rows.get('old')?.state).toBe('stored');
    expect(w.counters.stored).toBe(50);
  });

  it('keeps an old upload that is on a ticket', async () => {
    const w = world({ rows: [old({ state: 'stored', r2_upload_id: null, ticket_id: 't1' })], stored: 50 });
    await w.start({ ...VIDEO, bytes: 5 });
    expect(w.rows.get('old')?.state).toBe('stored');
  });

  it('makes room by expiring before it checks the free storage', async () => {
    const w = world({ rows: [old({ state: 'stored', r2_upload_id: null, bytes: FREE_STORAGE_BYTES })], stored: FREE_STORAGE_BYTES });
    expect((await w.start({ ...VIDEO, bytes: 5 })).status).toBe(201);
  });

  it('still starts when aborting an old upload fails, leaving that one pending for the admin desk to list', async () => {
    const stale: Row = {
      id: 'old',
      product_id: 'shytalk',
      r2_key: 'k',
      r2_upload_id: 'gone',
      thumb_key: 't',
      mime: 'video/mp4',
      bytes: 5,
      received_bytes: 0,
      duration_ms: null,
      state: 'pending',
      created_at: 0,
      deleted_at: null,
    };
    const w = world({ rows: [stale] });
    expect((await w.start({ ...VIDEO, bytes: 5 })).status).toBe(201);
    expect(w.rows.get('old')?.state).toBe('pending');
  });

  it('leaves an upload started under an hour ago alone', async () => {
    const recent: Row = {
      id: 'new',
      product_id: 'shytalk',
      r2_key: 'k',
      r2_upload_id: 'recent',
      thumb_key: 't',
      mime: 'video/mp4',
      bytes: 5,
      received_bytes: 0,
      duration_ms: null,
      state: 'pending',
      created_at: Date.now() - 60_000,
      deleted_at: null,
    };
    const w = world({ rows: [recent] });
    await w.start({ ...VIDEO, bytes: 5 });
    expect(w.r2.aborted).toEqual([]);
    expect(w.rows.get('new')?.state).toBe('pending');
  });

  it('is 404 with no CORS header from an origin the product does not allow', async () => {
    const w = world();
    const response = await w.call('/support-api/uploads', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers a preflight allowing PUT', async () => {
    const response = await world().call('/support-api/uploads/x/parts/1', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});

describe('sending a part', () => {
  const twoParts = async () => {
    const w = world();
    const { id } = (await (await w.start({ ...VIDEO, bytes: PART_SIZE + 10 })).json()) as { id: string };
    return { w, id };
  };

  it('stores a full middle part and answers its etag', async () => {
    const { w, id } = await twoParts();
    const response = await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(PART_SIZE));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ etag: 'etag-1' });
  });

  it('counts the bytes as each part arrives', async () => {
    const { w, id } = await twoParts();
    await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(PART_SIZE));
    expect(w.counters.stored).toBe(PART_SIZE);
    expect(w.rows.get(id)?.received_bytes).toBe(PART_SIZE);
  });

  it('refuses a part with no room left, storing none of it', async () => {
    const { w, id } = await twoParts();
    w.counters.stored = FREE_STORAGE_BYTES - 9;
    const response = await w.put(`/support-api/uploads/${id}/parts/2`, new Uint8Array(10));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.storageFull });
    expect(w.rows.get(id)?.received_bytes).toBe(0);
    expect(w.counters.stored).toBe(FREE_STORAGE_BYTES - 9);
  });

  it('stores a last part of exactly the remainder', async () => {
    const { w, id } = await twoParts();
    expect((await w.put(`/support-api/uploads/${id}/parts/2`, new Uint8Array(10))).status).toBe(200);
  });

  it('refuses a short middle part', async () => {
    const { w, id } = await twoParts();
    expect((await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(PART_SIZE - 1))).status).toBe(400);
  });

  it('refuses a part over 8 MB without reading it', async () => {
    const { w, id } = await twoParts();
    const response = await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(1), 'shytalk', PART_SIZE + 1);
    expect(response.status).toBe(413);
  });

  it('refuses a last part of the wrong length', async () => {
    const { w, id } = await twoParts();
    expect((await w.put(`/support-api/uploads/${id}/parts/2`, new Uint8Array(9))).status).toBe(400);
  });

  it('refuses a body shorter than its Content-Length says', async () => {
    const { w, id } = await twoParts();
    expect((await w.put(`/support-api/uploads/${id}/parts/2`, new Uint8Array(3), 'shytalk', 10)).status).toBe(400);
  });

  it('needs a Content-Length', async () => {
    const { w, id } = await twoParts();
    expect((await w.call(`/support-api/uploads/${id}/parts/2`, { method: 'PUT', body: new Uint8Array(10) })).status).toBe(411);
  });

  it.each(['0', '3', 'x', '1.5'])('refuses part number %s', async (n) => {
    const { w, id } = await twoParts();
    expect((await w.put(`/support-api/uploads/${id}/parts/${n}`, new Uint8Array(10))).status).toBe(400);
  });

  it("is 404 for another product's upload", async () => {
    const { w, id } = await twoParts();
    expect((await w.put(`/support-api/uploads/${id}/parts/2`, new Uint8Array(10), 'other')).status).toBe(404);
  });

  it('is 404 for an unknown upload', async () => {
    const { w } = await twoParts();
    expect((await w.put('/support-api/uploads/nope/parts/2', new Uint8Array(10))).status).toBe(404);
  });
});

describe('completing an upload', () => {
  it('keeps a WebP, with its bytes counted', async () => {
    const w = world();
    const bytes = fixture('uploads/photo.webp');
    const { id, response } = await w.uploadWhole('image', 'image/webp', bytes);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(w.rows.get(id)).toMatchObject({ state: 'stored', mime: 'image/webp', r2_upload_id: null, duration_ms: null });
    expect(w.counters.stored).toBe(bytes.length);
  });

  it('keeps the real 10 s video sent in two parts, recording its length', async () => {
    const w = world();
    const video = fixture('media/ok-10s.mp4');
    const { id } = (await (await w.start({ ...VIDEO, bytes: video.length })).json()) as { id: string };
    const first = (await (await w.put(`/support-api/uploads/${id}/parts/1`, video.subarray(0, PART_SIZE))).json()) as { etag: string };
    const second = (await (await w.put(`/support-api/uploads/${id}/parts/2`, video.subarray(PART_SIZE))).json()) as { etag: string };
    const response = await w.complete(id, [
      { n: 1, etag: first.etag },
      { n: 2, etag: second.etag },
    ]);
    expect(response.status).toBe(200);
    const row = w.rows.get(id);
    expect(row?.state).toBe('stored');
    expect(row?.duration_ms).toBeGreaterThan(9_500);
    expect(row?.duration_ms).toBeLessThan(10_500);
    expect(w.r2.objects.get(row?.r2_key ?? '')?.length).toBe(video.length);
  });

  it('keeps a JPEG', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole('image', 'image/jpeg', fixture('media/photo.jpg'));
    expect(response.status).toBe(200);
    expect(w.rows.get(id)?.mime).toBe('image/jpeg');
  });

  it('keeps a video of exactly 30 s, recording its length', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole(VIDEO.kind, VIDEO.mime, mp4OfMs(30_000));
    expect(response.status).toBe(200);
    expect(w.rows.get(id)).toMatchObject({ state: 'stored', duration_ms: 30_000 });
  });

  it('refuses a video one millisecond over 30 s and deletes it', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole(VIDEO.kind, VIDEO.mime, mp4OfMs(30_001));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.videoTooLong });
    expectRefused(w, id);
  });

  it('refuses the 45 s fixture and deletes it', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole(VIDEO.kind, VIDEO.mime, fixture('media/long-45s.mp4'));
    expect(response.status).toBe(422);
    expectRefused(w, id);
  });

  it('refuses text named as an MP4 and deletes it', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole(VIDEO.kind, VIDEO.mime, fixture('uploads/fake.mp4'));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.fileType });
    expectRefused(w, id);
  });

  it('refuses an MP4 whose length cannot be read and deletes it', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole(
      VIDEO.kind,
      VIDEO.mime,
      new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.fileType });
    expectRefused(w, id);
  });

  it('refuses a video sent as a photo and deletes it', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole('image', 'image/jpeg', mp4OfMs(5_000));
    expect(response.status).toBe(422);
    expectRefused(w, id);
  });

  it('refuses a WebP declared as a JPEG', async () => {
    const w = world();
    const { id, response } = await w.uploadWhole('image', 'image/jpeg', fixture('uploads/photo.webp'));
    expect(response.status).toBe(422);
    expectRefused(w, id);
  });

  it('refuses an object whose size is not the one declared', async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    const row = w.rows.get(id);
    await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(5));
    if (row) row.bytes = 6;
    const response = await w.complete(id, [{ n: 1, etag: 'etag-1' }]);
    expect(response.status).toBe(422);
    expectRefused(w, id);
  });

  it('refuses an object R2 cannot read back', async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(5));
    w.r2.state.vanishOnRead = true;
    expect((await w.complete(id, [{ n: 1, etag: 'etag-1' }])).status).toBe(422);
    expect(w.rows.get(id)?.state).toBe('deleted');
  });

  it('refuses a finish R2 refuses, marking it deleted', async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    const response = await w.complete(id, [{ n: 1, etag: 'wrong' }]);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.uploadFailed });
    expect(w.rows.get(id)?.state).toBe('deleted');
  });

  it('counts a part sent twice only once when the upload finishes', async () => {
    const w = world();
    const bytes = fixture('uploads/photo.webp');
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: bytes.length })).json()) as { id: string };
    await w.put(`/support-api/uploads/${id}/parts/1`, bytes);
    await w.put(`/support-api/uploads/${id}/parts/1`, bytes);
    expect(w.counters.stored).toBe(bytes.length * 2);
    expect((await w.complete(id, [{ n: 1, etag: 'etag-1' }])).status).toBe(200);
    expect(w.counters.stored).toBe(bytes.length);
  });

  it('gives back the bytes of a finish R2 refuses', async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(5));
    await w.complete(id, [{ n: 1, etag: 'wrong' }]);
    expect(w.counters.stored).toBe(0);
  });

  it('deletes the object and gives back its bytes when a check fails unexpectedly', async () => {
    const w = world();
    const bytes = fixture('uploads/photo.webp');
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: bytes.length })).json()) as { id: string };
    await w.put(`/support-api/uploads/${id}/parts/1`, bytes);
    w.r2.state.headThrows = true;
    const response = await w.complete(id, [{ n: 1, etag: 'etag-1' }]);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.uploadFailed });
    expectRefused(w, id);
  });

  it('is 404 for an upload another call is already finishing, leaving it alone', async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(5));
    const row = w.rows.get(id);
    w.statementsAnswering.claimLost = true;
    expect((await w.complete(id, [{ n: 1, etag: 'etag-1' }])).status).toBe(404);
    expect(row?.state).toBe('pending');
    expect(w.r2.deleted).toEqual([]);
  });

  it('refuses another part once the upload is being finished', async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    const row = w.rows.get(id);
    if (row) row.r2_upload_id = null;
    expect((await w.put(`/support-api/uploads/${id}/parts/1`, new Uint8Array(5))).status).toBe(404);
  });

  it.each([
    ['no parts', {}],
    ['parts that are not a list', { parts: 'x' }],
    ['a part with no etag', { parts: [{ n: 1 }] }],
    ['a part with no number', { parts: [{ etag: 'etag-1' }] }],
    ['too few parts', { parts: [] }],
  ])('is 400 for %s, keeping the upload open', async (_name, body) => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    const response = await w.call(`/support-api/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(w.rows.get(id)?.state).toBe('pending');
  });

  it('is 400 for a body that is not JSON', async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    expect((await w.call(`/support-api/uploads/${id}/complete`, { method: 'POST', body: 'nope' })).status).toBe(400);
  });

  it("is 404 for another product's upload, which stays untouched", async () => {
    const w = world();
    const { id } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { id: string };
    expect((await w.complete(id, [{ n: 1, etag: 'etag-1' }], 'other')).status).toBe(404);
    expect(w.rows.get(id)?.state).toBe('pending');
  });

  it('is 404 the second time', async () => {
    const w = world();
    const { id } = await w.uploadWhole('image', 'image/webp', fixture('uploads/photo.webp'));
    expect((await w.complete(id, [{ n: 1, etag: 'etag-1' }])).status).toBe(404);
  });
});

describe('sending a thumbnail', () => {
  const finished = async () => {
    const w = world();
    const photo = fixture('uploads/photo.webp');
    const done = await w.uploadWhole('image', 'image/webp', photo);
    return { w, photo, ...done };
  };

  it('stores it, adding its bytes to the attachment and the running total', async () => {
    const { w, id, thumbId, photo } = await finished();
    const response = await w.put(`/support-api/uploads/${thumbId}`, photo);
    expect(response.status).toBe(200);
    expect(w.r2.objects.get(w.rows.get(id)?.thumb_key ?? '')?.length).toBe(photo.length);
    expect(w.rows.get(id)?.bytes).toBe(photo.length * 2);
    expect(w.counters.stored).toBe(photo.length * 2);
  });

  it('accepts exactly 1 MB', async () => {
    const { w, thumbId } = await finished();
    const jpeg = new Uint8Array(1024 * 1024);
    jpeg.set([0xff, 0xd8, 0xff]);
    expect((await w.put(`/support-api/uploads/${thumbId}`, jpeg)).status).toBe(200);
  });

  it('refuses one byte over 1 MB', async () => {
    const { w, thumbId } = await finished();
    expect((await w.put(`/support-api/uploads/${thumbId}`, new Uint8Array(1), 'shytalk', 1024 * 1024 + 1)).status).toBe(413);
  });

  it('needs a Content-Length', async () => {
    const { w, thumbId } = await finished();
    expect((await w.call(`/support-api/uploads/${thumbId}`, { method: 'PUT', body: new Uint8Array(1) })).status).toBe(411);
  });

  it('refuses a body longer than 1 MB whatever its Content-Length says', async () => {
    const { w, thumbId } = await finished();
    expect((await w.put(`/support-api/uploads/${thumbId}`, new Uint8Array(1024 * 1024 + 1), 'shytalk', 10)).status).toBe(413);
  });

  it('refuses content that is not a picture', async () => {
    const { w, thumbId } = await finished();
    const response = await w.put(`/support-api/uploads/${thumbId}`, fixture('uploads/fake.mp4'));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: MESSAGES.fileType });
  });

  it('refuses a second one', async () => {
    const { w, thumbId, photo } = await finished();
    await w.put(`/support-api/uploads/${thumbId}`, photo);
    expect((await w.put(`/support-api/uploads/${thumbId}`, photo)).status).toBe(409);
  });

  it('refuses when the storage is full, storing nothing', async () => {
    const { w, id, thumbId, photo } = await finished();
    w.counters.stored = FREE_STORAGE_BYTES;
    const response = await w.put(`/support-api/uploads/${thumbId}`, photo);
    expect(response.status).toBe(422);
    expect(w.r2.objects.has(w.rows.get(id)?.thumb_key ?? '')).toBe(false);
  });

  it('is 404 before the upload has finished', async () => {
    const w = world();
    const { thumbId } = (await (await w.start({ kind: 'image', mime: 'image/webp', bytes: 5 })).json()) as { thumbId: string };
    expect((await w.put(`/support-api/uploads/${thumbId}`, fixture('uploads/photo.webp'))).status).toBe(404);
  });

  it('is 404 for another product', async () => {
    const { w, thumbId, photo } = await finished();
    expect((await w.put(`/support-api/uploads/${thumbId}`, photo, 'other')).status).toBe(404);
  });
});

/** An MP4 small enough to send whole, with exactly this length in its header. */
function mp4OfMs(ms: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ascii = (s: string) => Array.from(s, (ch) => ch.charCodeAt(0));
  const box = (type: string, payload: number[]) => [...u32(payload.length + 8), ...ascii(type), ...payload];
  return new Uint8Array([
    ...box('ftyp', ascii('isom')),
    ...box('moov', box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1000), ...u32(ms)])),
  ]);
}

function expectRefused(w: ReturnType<typeof world>, id: string): void {
  const row = w.rows.get(id);
  expect(row?.state).toBe('deleted');
  expect(w.r2.objects.has(row?.r2_key ?? '')).toBe(false);
  expect(w.r2.deleted).toContain(row?.r2_key);
  expect(w.counters.stored).toBe(0);
}
