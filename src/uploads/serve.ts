import type { R2Bucket } from '@cloudflare/workers-types';
import type { Context } from 'hono';

/** Where a stored attachment and its preview are kept. */
export interface StoredFile {
  r2_key: string;
  thumb_key: string | null;
  mime: string;
}

/** The only types an upload can be stored as (src/uploads/routes.ts checks the bytes): only these show inline. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/webp', 'video/mp4']);

/**
 * Streams the object at `key` from `bucket` for viewing (shyden-labs/shydesk#25
 * AC2): shown in the page and never offered as a download, private to this
 * reader and never sniffed; null if it has gone. Through the context, so
 * headers set by middleware (the piece's CORS) stay on the answer.
 *
 * Defence in depth, since files share the desk's origin and its sign-in: a
 * type outside JPEG, WebP and MP4 (none can be stored today) downloads as
 * plain bytes instead, and a file opened on its own runs and fetches nothing.
 */
export async function streamFile(c: Context, bucket: R2Bucket, key: string | null, mime?: string): Promise<Response | null> {
  const object = key === null ? null : await bucket.get(key);
  if (object === null) return null;
  // A preview is a JPEG or a WebP: the type it was stored with says which.
  const stored = mime ?? object.httpMetadata?.contentType ?? 'image/jpeg';
  const inline = INLINE_TYPES.has(stored);
  return c.body(object.body as unknown as ReadableStream, 200, {
    'Content-Type': inline ? stored : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}
