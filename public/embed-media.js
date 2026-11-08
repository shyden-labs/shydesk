/// <reference lib="dom" />
/**
 * The shared piece's media code (shyden-labs/shydesk#21), imported from ShyDesk
 * on the first file a customer picks, so a form with no attachments stays small.
 * Photos shrink in the browser. Videos go as they are until a video encoder is
 * chosen (shyden-labs/shydesk#21); `planVideo` holds the sizes it will use.
 *
 * A plain module, typed with JSDoc and checked by `tsc`, so it ships as written.
 */

const FAILED = 'The file could not be uploaded. Try again.';
const THUMBNAIL_EDGE = 320;
/** A browser that never reports on a file gets no answer, not an endless wait. */
const MEDIA_WAIT_MS = 5000;

/** The size a photo is sent at: long edge at most 2560 px, shape kept, never bigger. */
export function planImage(/** @type {number} */ w, /** @type {number} */ h) {
  const scale = Math.min(1, 2560 / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale), quality: 0.85 };
}

const even = (/** @type {number} */ n) => Math.floor(n / 2) * 2;

/** The size a video is sent at: long edge at most 1920 px, even, at most 30 fps, never bigger. */
export function planVideo(/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ fps) {
  const scale = Math.min(1, 1920 / Math.max(w, h));
  return { w: even(w * scale), h: even(h * scale), fps: Math.min(30, fps), bitrate: 5_000_000 };
}

/**
 * @param {Blob} original
 * @param {Blob | null} compressed
 * @returns {Blob}
 */
export function pickSmaller(original, compressed) {
  return compressed !== null && compressed.size < original.size ? compressed : original;
}

/**
 * How a file of this type goes to the server, which keeps only JPEG, WebP and
 * MP4. Any other photo the browser can draw is converted. A QuickTime video,
 * as iPhones record, shares MP4's container. Null: this type cannot be sent.
 * @param {string} type
 * @returns {{ kind: 'image' | 'video', mime: string, mustConvert: boolean } | null}
 */
export function uploadShape(type) {
  if (type === 'image/jpeg' || type === 'image/webp') return { kind: 'image', mime: type, mustConvert: false };
  if (type.startsWith('image/')) return { kind: 'image', mime: 'image/jpeg', mustConvert: true };
  if (type === 'video/mp4' || type === 'video/quicktime') return { kind: 'video', mime: 'video/mp4', mustConvert: false };
  return null;
}

export const kilobytes = (/** @type {number} */ bytes) => Math.ceil(bytes / 1000);

/**
 * @param {CanvasImageSource} source
 * @param {number} w
 * @param {number} h
 * @param {number} quality
 * @returns {Promise<Blob | null>}
 */
function jpegOf(source, w, h, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (context === null) return Promise.resolve(null);
  context.drawImage(source, 0, 0, w, h);
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}

/**
 * The photo as a JPEG at its planned size, or null if this browser cannot draw it.
 * @param {Blob} file
 * @returns {Promise<Blob | null>}
 */
export async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const { w, h, quality } = planImage(bitmap.width, bitmap.height);
    return await jpegOf(bitmap, w, h, quality);
  } catch {
    return null;
  }
}

/**
 * Runs `use` on a video element holding the file, once `event` has fired; null
 * if the browser reports an error or nothing within MEDIA_WAIT_MS.
 * @template T
 * @param {Blob} file
 * @param {string} event
 * @param {(video: HTMLVideoElement) => T | Promise<T>} use
 * @returns {Promise<T | null>}
 */
async function withVideo(file, event, use) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    /** @type {boolean} */
    const ready = await new Promise((/** @type {(value: boolean) => void} */ resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, MEDIA_WAIT_MS);
      video.addEventListener(event, () => {
        resolve(true);
      });
      video.addEventListener('error', () => {
        resolve(false);
      });
      video.src = url;
    });
    return ready ? await use(video) : null;
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
}

/**
 * The video's length in seconds, or null if the browser cannot tell: the server still checks.
 * @param {Blob} file
 * @returns {Promise<number | null>}
 */
export function videoSeconds(file) {
  return withVideo(file, 'loadedmetadata', (video) => (Number.isFinite(video.duration) ? video.duration : null));
}

/**
 * A small JPEG preview: the photo, or the video's first frame. Null if it cannot be made.
 * @param {Blob} file
 * @param {'image' | 'video'} kind
 * @returns {Promise<Blob | null>}
 */
export async function thumbnailOf(file, kind) {
  const fit = (/** @type {number} */ w, /** @type {number} */ h) => {
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  };
  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(file);
      const { w, h } = fit(bitmap.width, bitmap.height);
      return await jpegOf(bitmap, w, h, 0.8);
    }
    return await withVideo(file, 'loadeddata', (video) => {
      const { w, h } = fit(video.videoWidth, video.videoHeight);
      return jpegOf(video, w, h, 0.8);
    });
  } catch {
    return null;
  }
}

/**
 * The answer's JSON, or throws the server's own reason, or plain words if it gave none.
 * @param {Response} response
 * @returns {Promise<Record<string, unknown>>}
 */
async function answerOf(response) {
  /** @type {Record<string, unknown>} */
  let body;
  try {
    const raw = /** @type {unknown} */ (await response.json());
    body = /** @type {Record<string, unknown>} */ (raw);
  } catch {
    throw new Error(FAILED);
  }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : FAILED);
  return body;
}

/**
 * Sends one file straight to ShyDesk, one part at a time.
 * @param {{ host: string, product: string, file: Blob, kind: string, mime: string, thumbnail: Blob | null, fetcher?: typeof fetch, onProgress?: (done: number) => void }} upload
 * @returns {Promise<{ id: string, bytes: number }>}
 */
export async function uploadAttachment({ host, product, file, kind, mime, thumbnail, fetcher = fetch, onProgress }) {
  const url = (/** @type {string} */ path) => `${host}/support-api/uploads${path}?product=${encodeURIComponent(product)}`;
  /** A request that cannot connect throws the browser's own words, which mean nothing to a customer. */
  const ask = async (/** @type {string} */ address, /** @type {RequestInit} */ init) => {
    try {
      return await fetcher(address, init);
    } catch {
      throw new Error(FAILED);
    }
  };
  const started = await answerOf(
    await ask(url(''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, mime, bytes: file.size }),
    }),
  );
  const { id, partSize, parts: count, thumbId } = /** @type {{ id: string, partSize: number, parts: number, thumbId: string }} */ (started);
  const parts = [];
  for (let n = 1; n <= count; n += 1) {
    const end = Math.min(n * partSize, file.size);
    const body = file.slice((n - 1) * partSize, end);
    const sent = await answerOf(await ask(url(`/${id}/parts/${String(n)}`), { method: 'PUT', body }));
    parts.push({ n, etag: sent.etag });
    onProgress?.(end / file.size);
  }
  await answerOf(
    await ask(url(`/${id}/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts }),
    }),
  );
  if (thumbnail !== null) {
    // Only a preview: the desk shows a plain icon without one, so the file still counts as sent.
    await fetcher(url(`/${thumbId}`), { method: 'PUT', body: thumbnail }).catch(() => null);
  }
  return { id, bytes: file.size };
}
