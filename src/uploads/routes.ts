import type { R2Bucket } from '@cloudflare/workers-types';
import { Hono, type Context } from 'hono';
import { MESSAGES } from '../customer/messages.ts';
import { requireProductOrigin } from '../customer/origin.ts';
import { UNATTACHED_EXPIRES_MS, UPLOAD_ABANDONED_MS } from '../desk/overdue.ts';
import type { Env } from '../env.ts';
import { hit } from '../limits.ts';
import type { Product } from '../products.ts';
import { addStoredWithin, FREE_STORAGE_BYTES, STORED_BYTES, storedBytes } from '../storage.ts';
import { mp4DurationMs } from './mp4.ts';
import { sniff } from './sniff.ts';

/**
 * Attachment uploads, straight from the browser to ShyDesk (shyden-labs/shydesk#20;
 * plan Task 6). A file goes in parts of 8 MiB into an R2 multipart upload through
 * the bucket binding, and on `complete` the server decides by content what it
 * keeps. There is no per-file size limit (Shyden): only the free storage, and a
 * video's 30 s, can refuse a file.
 *
 * - `POST /support-api/uploads?product=<id>`: `{ kind, mime, bytes }` starts one.
 * - `PUT /support-api/uploads/:id/parts/:n?product=<id>`: one part's raw bytes.
 * - `POST /support-api/uploads/:id/complete?product=<id>`: `{ parts: [{ n, etag }] }`.
 * - `PUT /support-api/uploads/:thumbId?product=<id>`: the preview, after `complete`.
 */

export const PART_SIZE = 8 * 1024 * 1024;
const THUMBNAIL_MAX_BYTES = 1024 * 1024;
const MAX_VIDEO_MS = 30_000;
const HEAD_BYTES = 64 * 1024;
const HOUR_SECONDS = 3600;
/** Plan Task 6's limit: with no Turnstile on uploads, a script could otherwise fill the storage. */
const STARTS_PER_IP = 30;
/** Builder call: ten times one IP's limit, so one product's page cannot take the storage from the rest. */
const STARTS_PER_PRODUCT = 300;
/** Few enough that one start stays well inside the free plan's 50 outside calls per request. */
const STALE_PER_START = 5;

const MIMES: Record<string, string[]> = { image: ['image/jpeg', 'image/webp'], video: ['video/mp4'] };
const MIME_OF = { jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4' } as const;

export interface UploadBindings extends Env {
  FILES: R2Bucket;
}

interface UploadEnv {
  Bindings: UploadBindings;
  Variables: { product: Product; clientIp: string };
}

interface Attachment {
  id: string;
  r2_key: string;
  /** Null once a `complete` has claimed it, so nothing else can touch the upload. */
  r2_upload_id: string | null;
  thumb_key: string;
  mime: string;
  bytes: number;
  received_bytes: number;
}

const COLUMNS = 'id, r2_key, r2_upload_id, thumb_key, mime, bytes, received_bytes';

const partCount = (bytes: number): number => Math.ceil(bytes / PART_SIZE);
const thumbKey = (productId: string, thumbId: string): string => `${productId}/thumbs/${thumbId}`;

async function bodyOf(c: Context<UploadEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Pending = Attachment & { r2_upload_id: string };

/**
 * Marks an attachment deleted and takes it off the running total, together and
 * only if it is still in `state`, so two calls reaching one attachment take it
 * off once. A pending upload gives back what it received, read fresh so a part
 * that arrived late counts; a stored one gives back its size.
 */
export const closeOut = (env: Pick<UploadBindings, 'DB'>, id: string, state: 'pending' | 'stored'): Promise<unknown> =>
  env.DB.batch([
    env.DB.prepare(
      `UPDATE counters SET value = value - (SELECT ${state === 'pending' ? 'received_bytes' : 'bytes'} FROM attachments WHERE id = ?1 AND state = ?2)
       WHERE key = ?3 AND EXISTS (SELECT 1 FROM attachments WHERE id = ?1 AND state = ?2)`,
    ).bind(id, state, STORED_BYTES),
    env.DB.prepare("UPDATE attachments SET state = 'deleted', deleted_at = ?1 WHERE id = ?2 AND state = ?3").bind(Date.now(), id, state),
  ]);

/** The Content-Length as a number, or null if it is missing or is not one. */
function declaredLength(c: Context<UploadEnv>): number | null {
  const header = c.req.header('Content-Length') ?? '';
  return /^\d+$/.test(header) ? Number(header) : null;
}

/**
 * Clears what customers left behind, with no clock: each new start, for any
 * product, since all share one free storage. An upload pending over an hour is
 * aborted, and a finished one never put on a ticket after a day is deleted. One
 * that cannot be cleared stays for the admin desk's overdue panel to list, and
 * never stops a new upload.
 */
async function clearAbandoned(env: UploadBindings): Promise<void> {
  const now = Date.now();
  const { results: stale } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM attachments WHERE state = 'pending' AND created_at < ? ORDER BY created_at LIMIT ${String(STALE_PER_START)}`,
  )
    .bind(now - UPLOAD_ABANDONED_MS)
    .all<Attachment>();
  const { results: unattached } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM attachments WHERE state = 'stored' AND ticket_id IS NULL AND created_at < ? ORDER BY created_at LIMIT ${String(STALE_PER_START)}`,
  )
    .bind(now - UNATTACHED_EXPIRES_MS)
    .all<Attachment>();
  for (const row of stale) {
    try {
      // With no upload id a `complete` stopped part way, and the object may exist.
      if (row.r2_upload_id !== null) await env.FILES.resumeMultipartUpload(row.r2_key, row.r2_upload_id).abort();
      else await env.FILES.delete(row.r2_key);
      await closeOut(env, row.id, 'pending');
    } catch (error) {
      console.error(`upload ${row.id} could not be aborted`, error);
    }
  }
  for (const row of unattached) {
    try {
      await env.FILES.delete([row.r2_key, row.thumb_key]);
      await closeOut(env, row.id, 'stored');
    } catch (error) {
      console.error(`upload ${row.id} could not be expired`, error);
    }
  }
}

const pending = (env: UploadBindings, id: string, productId: string): Promise<Pending | null> =>
  env.DB.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ? AND product_id = ? AND state = 'pending' AND r2_upload_id IS NOT NULL`)
    .bind(id, productId)
    .first<Pending>();

/** Why the finished object cannot be kept, or its length when it can. */
async function check(env: UploadBindings, row: Attachment): Promise<{ error: string } | { durationMs: number | null }> {
  const stored = await env.FILES.head(row.r2_key);
  if (stored?.size !== row.bytes) return { error: MESSAGES.uploadFailed };
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    const part = await env.FILES.get(row.r2_key, { range: { offset, length } });
    return part ? new Uint8Array(await part.arrayBuffer()) : new Uint8Array();
  };
  const kind = sniff(await read(0, Math.min(HEAD_BYTES, row.bytes)));
  if (kind === null || MIME_OF[kind] !== row.mime) return { error: MESSAGES.fileType };
  if (kind !== 'mp4') return { durationMs: null };
  const durationMs = await mp4DurationMs(read, row.bytes);
  if (durationMs === null) return { error: MESSAGES.fileType };
  if (durationMs > MAX_VIDEO_MS) return { error: MESSAGES.videoTooLong };
  return { durationMs };
}

function parsedParts(body: unknown, expected: number): { partNumber: number; etag: string }[] | null {
  if (!isRecord(body) || !Array.isArray(body.parts) || body.parts.length !== expected) return null;
  const parts = (body.parts as unknown[]).map((p) =>
    isRecord(p) && Number.isInteger(p.n) && typeof p.etag === 'string' ? { partNumber: p.n as number, etag: p.etag } : null,
  );
  return parts.every((p) => p !== null) ? parts : null;
}

export function uploadRoutes(): Hono<UploadEnv> {
  const app = new Hono<UploadEnv>();
  app.use('/support-api/uploads/*', requireProductOrigin());

  app.post('/support-api/uploads', async (c) => {
    const body = await bodyOf(c);
    if (!isRecord(body)) return c.json({ error: MESSAGES.badRequest }, 400);
    const { kind, mime, bytes } = body;
    const allowed = typeof kind === 'string' && Object.hasOwn(MIMES, kind) ? MIMES[kind] : [];
    if (typeof mime !== 'string' || !allowed?.includes(mime) || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) {
      return c.json({ error: MESSAGES.badRequest }, 400);
    }
    const product = c.var.product;
    const db = c.env.DB;
    if (!(await hit(db, `upload-ip:${c.var.clientIp}`, STARTS_PER_IP, HOUR_SECONDS))) return c.json({ error: MESSAGES.tooMany }, 429);
    if (!(await hit(db, `upload-product:${product.id}`, STARTS_PER_PRODUCT, HOUR_SECONDS))) return c.json({ error: MESSAGES.tooMany }, 429);
    await clearAbandoned(c.env);
    if ((await storedBytes(db)) + bytes > FREE_STORAGE_BYTES) return c.json({ error: MESSAGES.storageFull }, 422);

    const id = crypto.randomUUID();
    const thumbId = crypto.randomUUID();
    const key = `${product.id}/${id}`;
    const upload = await c.env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
    await db
      .prepare(
        `INSERT INTO attachments (id, product_id, r2_key, r2_upload_id, thumb_key, mime, bytes, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(id, product.id, key, upload.uploadId, thumbKey(product.id, thumbId), mime, bytes, Date.now())
      .run();
    return c.json({ id, partSize: PART_SIZE, parts: partCount(bytes), thumbId }, 201);
  });

  app.put('/support-api/uploads/:id/parts/:n', async (c) => {
    const row = await pending(c.env, c.req.param('id'), c.var.product.id);
    if (!row) return c.json({ error: MESSAGES.notFound }, 404);
    const raw = c.req.param('n');
    const parts = partCount(row.bytes);
    const n = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (n < 1 || n > parts) return c.json({ error: MESSAGES.badRequest }, 400);
    const length = declaredLength(c);
    if (length === null) return c.json({ error: MESSAGES.badRequest }, 411);
    if (length > PART_SIZE) return c.json({ error: MESSAGES.badRequest }, 413);
    const expected = n < parts ? PART_SIZE : row.bytes - PART_SIZE * (parts - 1);
    if (length !== expected) return c.json({ error: MESSAGES.badRequest }, 400);
    const body = await c.req.arrayBuffer();
    if (body.byteLength !== expected) return c.json({ error: MESSAGES.badRequest }, 400);
    // Counted before R2 holds it: parts cost storage even before the upload finishes.
    if (!(await addStoredWithin(c.env.DB, expected))) return c.json({ error: MESSAGES.storageFull }, 422);
    await c.env.DB.prepare('UPDATE attachments SET received_bytes = received_bytes + ? WHERE id = ?').bind(expected, row.id).run();
    const part = await c.env.FILES.resumeMultipartUpload(row.r2_key, row.r2_upload_id).uploadPart(n, body);
    return c.json({ etag: part.etag });
  });

  app.post('/support-api/uploads/:id/complete', async (c) => {
    const row = await pending(c.env, c.req.param('id'), c.var.product.id);
    if (!row) return c.json({ error: MESSAGES.notFound }, 404);
    const parts = parsedParts(await bodyOf(c), partCount(row.bytes));
    if (!parts) return c.json({ error: MESSAGES.badRequest }, 400);
    // Only one call can claim it, so a second `complete` can never delete what the first kept.
    const claimed = await c.env.DB.prepare(
      `UPDATE attachments SET r2_upload_id = NULL WHERE id = ? AND product_id = ? AND state = 'pending' AND r2_upload_id IS NOT NULL RETURNING ${COLUMNS}`,
    )
      .bind(row.id, c.var.product.id)
      .first<Attachment>();
    if (!claimed) return c.json({ error: MESSAGES.notFound }, 404);
    const upload = c.env.FILES.resumeMultipartUpload(claimed.r2_key, row.r2_upload_id);
    try {
      await upload.complete(parts);
    } catch (error) {
      console.error(`upload ${claimed.id} could not be completed`, error);
      await upload.abort();
      await closeOut(c.env, claimed.id, 'pending');
      return c.json({ error: MESSAGES.uploadFailed }, 422);
    }
    const refuse = async (error: string): Promise<Response> => {
      await c.env.FILES.delete(claimed.r2_key);
      await closeOut(c.env, claimed.id, 'pending');
      return c.json({ error }, 422);
    };
    let checked: Awaited<ReturnType<typeof check>>;
    try {
      checked = await check(c.env, claimed);
    } catch (error) {
      console.error(`upload ${claimed.id} could not be checked`, error);
      return refuse(MESSAGES.uploadFailed);
    }
    if ('error' in checked) return refuse(checked.error);
    // Keeps the file's own size in the total: a part sent twice was counted twice.
    const [, kept] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE counters SET value = value - (SELECT received_bytes - bytes FROM attachments WHERE id = ?1 AND state = ?2)
         WHERE key = ?3 AND EXISTS (SELECT 1 FROM attachments WHERE id = ?1 AND state = ?2)`,
      ).bind(claimed.id, 'pending', STORED_BYTES),
      c.env.DB.prepare(
        "UPDATE attachments SET mime = ?, duration_ms = ?, state = 'stored' WHERE id = ? AND state = 'pending' RETURNING id",
      ).bind(claimed.mime, checked.durationMs, claimed.id),
    ]);
    // A clear-out took it meanwhile (it was over an hour old), perhaps before this finish made the object.
    if (kept?.results.length !== 1) {
      await c.env.FILES.delete(claimed.r2_key);
      return c.json({ error: MESSAGES.uploadFailed }, 422);
    }
    return c.json({ ok: true });
  });

  app.put('/support-api/uploads/:thumbId', async (c) => {
    const key = thumbKey(c.var.product.id, c.req.param('thumbId'));
    const row = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM attachments WHERE thumb_key = ? AND product_id = ? AND state = 'stored'`)
      .bind(key, c.var.product.id)
      .first<Attachment>();
    if (!row) return c.json({ error: MESSAGES.notFound }, 404);
    const length = declaredLength(c);
    if (length === null) return c.json({ error: MESSAGES.badRequest }, 411);
    if (length > THUMBNAIL_MAX_BYTES) return c.json({ error: MESSAGES.thumbnailTooLarge }, 413);
    if (await c.env.FILES.head(key)) return c.json({ error: MESSAGES.badRequest }, 409);
    const body = await c.req.arrayBuffer();
    if (body.byteLength > THUMBNAIL_MAX_BYTES) return c.json({ error: MESSAGES.thumbnailTooLarge }, 413);
    const kind = sniff(new Uint8Array(body.slice(0, 64)));
    if (kind !== 'jpeg' && kind !== 'webp') return c.json({ error: MESSAGES.fileType }, 422);
    if (!(await addStoredWithin(c.env.DB, body.byteLength))) return c.json({ error: MESSAGES.storageFull }, 422);
    await c.env.FILES.put(key, body, { httpMetadata: { contentType: MIME_OF[kind] } });
    // On the attachment too: retention takes `bytes` off the total when it deletes both objects.
    await c.env.DB.prepare('UPDATE attachments SET bytes = bytes + ? WHERE id = ?').bind(body.byteLength, row.id).run();
    return c.json({ ok: true });
  });

  return app;
}
