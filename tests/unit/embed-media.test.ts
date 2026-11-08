import { afterEach, describe, expect, it, vi } from 'vitest';
import { kilobytes, pickSmaller, planImage, planVideo, shrinkVideo, uploadAttachment, uploadShape } from '../../public/embed-media.js';

// What the shared piece decides about a file before and while it uploads
// (shyden-labs/shydesk#21). Drawing and encoding need a browser: the e2e suite covers those.
describe('planImage', () => {
  it('brings a 4000×3000 photo down to a 2560 px long edge at quality 0.85', () => {
    expect(planImage(4000, 3000)).toEqual({ w: 2560, h: 1920, quality: 0.85 });
  });

  it('keeps the shape of a portrait photo', () => {
    expect(planImage(3000, 4000)).toEqual({ w: 1920, h: 2560, quality: 0.85 });
  });

  it('leaves a 2560 px photo its size', () => {
    expect(planImage(2560, 100)).toEqual({ w: 2560, h: 100, quality: 0.85 });
  });

  it('never makes a small photo bigger', () => {
    expect(planImage(640, 480)).toEqual({ w: 640, h: 480, quality: 0.85 });
  });
});

describe('planVideo', () => {
  it('brings 4K at 60 fps down to 1080p at 30 fps and 5 Mbit/s', () => {
    expect(planVideo(3840, 2160, 60)).toEqual({ w: 1920, h: 1080, fps: 30, bitrate: 5_000_000 });
  });

  it('keeps the shape of a portrait video', () => {
    expect(planVideo(2160, 3840, 30)).toEqual({ w: 1080, h: 1920, fps: 30, bitrate: 5_000_000 });
  });

  it('never makes a small video bigger or faster', () => {
    expect(planVideo(640, 480, 24)).toEqual({ w: 640, h: 480, fps: 24, bitrate: 5_000_000 });
  });

  it('rounds an odd size down to even, as the encoder needs', () => {
    expect(planVideo(641, 481, 30)).toEqual({ w: 640, h: 480, fps: 30, bitrate: 5_000_000 });
  });
});

describe('pickSmaller', () => {
  const big = new Blob(['123456']);
  const small = new Blob(['12']);

  it('takes the compressed file when it is smaller', () => {
    expect(pickSmaller(big, small)).toBe(small);
  });

  it('keeps the original when compressing made it bigger', () => {
    expect(pickSmaller(small, big)).toBe(small);
  });

  it('keeps the original at the same size', () => {
    const same = new Blob(['12']);
    expect(pickSmaller(small, same)).toBe(small);
  });

  it('keeps the original when there is no compressed file', () => {
    expect(pickSmaller(big, null)).toBe(big);
  });
});

describe('uploadShape', () => {
  it.each([
    ['image/jpeg', { kind: 'image', mime: 'image/jpeg', mustConvert: false }],
    ['image/webp', { kind: 'image', mime: 'image/webp', mustConvert: false }],
    ['image/png', { kind: 'image', mime: 'image/jpeg', mustConvert: true }],
    ['image/heic', { kind: 'image', mime: 'image/jpeg', mustConvert: true }],
    ['video/mp4', { kind: 'video', mime: 'video/mp4', mustConvert: false }],
    ['video/quicktime', { kind: 'video', mime: 'video/mp4', mustConvert: false }],
  ])('sends %s as the server expects', (type, shape) => {
    expect(uploadShape(type)).toEqual(shape);
  });

  it.each(['video/webm', 'application/pdf', 'text/plain', ''])('has no way to send "%s"', (type) => {
    expect(uploadShape(type)).toBeNull();
  });
});

describe('kilobytes', () => {
  it.each([
    [1, 1],
    [1000, 1],
    [1001, 2],
    [3_010_902, 3011],
  ])('%d bytes read as %d KB', (bytes, kb) => {
    expect(kilobytes(bytes)).toBe(kb);
  });
});

describe('uploadAttachment', () => {
  const HOST = 'https://shydesk.example';
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  /** Answers like the server, recording every call, with `override` for a chosen path. */
  function server(override: (path: string, method: string) => Response | undefined = () => undefined) {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      const body = init.body instanceof Blob ? await init.body.text() : init.body;
      calls.push({ path: `${u.pathname}${u.search}`, method, body });
      const chosen = override(u.pathname, method);
      if (chosen) return chosen;
      if (u.pathname.endsWith('/uploads')) return json(201, { id: 'u1', partSize: 4, parts: 3, thumbId: 't1' });
      if (u.pathname.includes('/parts/')) return json(200, { etag: `etag-${u.pathname.slice(-1)}` });
      return json(200, { ok: true });
    };
    return { calls, fetcher: fetcher as unknown as typeof fetch };
  }
  const send = (fetcher: typeof fetch, extra: object = {}) =>
    uploadAttachment({
      host: HOST,
      product: 'demo',
      file: new Blob(['0123456789']),
      kind: 'image',
      mime: 'image/jpeg',
      thumbnail: null,
      fetcher,
      ...extra,
    });

  it('starts, sends each part in order, then completes with the etags', async () => {
    const { calls, fetcher } = server();
    expect(await send(fetcher)).toEqual({ id: 'u1', bytes: 10 });
    expect(calls).toEqual([
      { path: '/support-api/uploads?product=demo', method: 'POST', body: JSON.stringify({ kind: 'image', mime: 'image/jpeg', bytes: 10 }) },
      { path: '/support-api/uploads/u1/parts/1?product=demo', method: 'PUT', body: '0123' },
      { path: '/support-api/uploads/u1/parts/2?product=demo', method: 'PUT', body: '4567' },
      { path: '/support-api/uploads/u1/parts/3?product=demo', method: 'PUT', body: '89' },
      {
        path: '/support-api/uploads/u1/complete?product=demo',
        method: 'POST',
        body: JSON.stringify({
          parts: [
            { n: 1, etag: 'etag-1' },
            { n: 2, etag: 'etag-2' },
            { n: 3, etag: 'etag-3' },
          ],
        }),
      },
    ]);
  });

  it('reports progress after each part', async () => {
    const seen: number[] = [];
    await send(server().fetcher, { onProgress: (done: number) => seen.push(done) });
    expect(seen).toEqual([0.4, 0.8, 1]);
  });

  it('sends the thumbnail after completing', async () => {
    const { calls, fetcher } = server();
    await send(fetcher, { thumbnail: new Blob(['thumb']) });
    expect(calls.at(-1)).toEqual({ path: '/support-api/uploads/t1?product=demo', method: 'PUT', body: 'thumb' });
  });

  it('keeps the upload when only the thumbnail fails', async () => {
    const { fetcher } = server((path) => (path.endsWith('/t1') ? json(422, { error: 'no' }) : undefined));
    expect(await send(fetcher, { thumbnail: new Blob(['thumb']) })).toEqual({ id: 'u1', bytes: 10 });
  });

  it('keeps the upload when the thumbnail request cannot connect', async () => {
    const { fetcher } = server();
    const failing = ((url: string, init: RequestInit) =>
      url.includes('/t1') ? Promise.reject(new Error('offline')) : fetcher(url, init)) as unknown as typeof fetch;
    expect(await send(failing, { thumbnail: new Blob(['thumb']) })).toEqual({ id: 'u1', bytes: 10 });
  });

  it("fails with the server's words when the start is refused", async () => {
    const { calls, fetcher } = server((path) => (path.endsWith('/uploads') ? json(422, { error: 'Storage is full.' }) : undefined));
    await expect(send(fetcher)).rejects.toThrow('Storage is full.');
    expect(calls).toHaveLength(1);
  });

  it("fails with the server's words when a part is refused, sending no more", async () => {
    const { calls, fetcher } = server((path) => (path.endsWith('/parts/2') ? json(422, { error: 'No room.' }) : undefined));
    await expect(send(fetcher)).rejects.toThrow('No room.');
    expect(calls).toHaveLength(3);
  });

  it("fails with the server's words when completing is refused", async () => {
    const { fetcher } = server((path) => (path.endsWith('/complete') ? json(422, { error: 'Too long.' }) : undefined));
    await expect(send(fetcher)).rejects.toThrow('Too long.');
  });

  it("fails in plain words when a request cannot connect, never the browser's own", async () => {
    const offline = (() => Promise.reject(new TypeError('Load failed'))) as unknown as typeof fetch;
    await expect(send(offline)).rejects.toThrow('The file could not be uploaded. Try again.');
  });

  it('fails in plain words when an answer is not readable', async () => {
    const { fetcher } = server((path) => (path.endsWith('/complete') ? new Response('<html>', { status: 500 }) : undefined));
    await expect(send(fetcher)).rejects.toThrow('The file could not be uploaded. Try again.');
  });

  it('fails in plain words when a refusal gives no reason', async () => {
    const { fetcher } = server((path) => (path.endsWith('/complete') ? json(500, {}) : undefined));
    await expect(send(fetcher)).rejects.toThrow('The file could not be uploaded. Try again.');
  });
});

describe('shrinkVideo', () => {
  type Options = Record<string, unknown>;

  const bigTrack = {
    getDisplayWidth: () => Promise.resolve(3840),
    getDisplayHeight: () => Promise.resolve(2160),
    computePacketStats: () => Promise.resolve({ averagePacketRate: 60 }),
  };

  /** Stands in for the video library, recording what the conversion was asked for. */
  function videoTools({
    isValid = true,
    discardedTracks = [],
    track = bigTrack,
    execute = () => Promise.resolve(),
  }: {
    isValid?: boolean;
    discardedTracks?: { reason: string }[];
    track?: typeof bigTrack | null;
    execute?: () => Promise<void>;
  } = {}) {
    const asked: Options[] = [];
    const cancel = vi.fn(() => Promise.resolve());
    const tools = {
      ALL_FORMATS: [],
      BlobSource: Object,
      Input: class {
        getPrimaryVideoTrack = () => Promise.resolve(track);
      },
      Mp4OutputFormat: Object,
      BufferTarget: class {
        buffer = new Uint8Array([1, 2, 3]).buffer;
      },
      Output: class {
        target: unknown;
        constructor(options: { target: unknown }) {
          this.target = options.target;
        }
      },
      Conversion: {
        init: (options: Options) => {
          asked.push(options);
          return Promise.resolve({ isValid, discardedTracks, execute, cancel });
        },
      },
    };
    return { asked, cancel, load: () => Promise.resolve(tools as never) };
  }
  const file = new File(['original'], 'clip.mp4', { type: 'video/mp4' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('encodes at the planned size, frame rate and bitrate, with AAC at 128 kbit/s', async () => {
    const { asked, load } = videoTools();
    await shrinkVideo(file, load);
    expect(asked[0]?.video).toEqual({
      width: 1920,
      height: 1080,
      fit: 'contain',
      frameRate: 30,
      codec: 'avc',
      bitrate: 5_000_000,
      forceTranscode: true,
    });
    expect(asked[0]?.audio).toEqual({ codec: 'aac', bitrate: 128_000 });
  });

  it('never makes a small, slow video bigger or faster', async () => {
    const track = {
      getDisplayWidth: () => Promise.resolve(640),
      getDisplayHeight: () => Promise.resolve(360),
      computePacketStats: () => Promise.resolve({ averagePacketRate: 24 }),
    };
    const { asked, load } = videoTools({ track });
    await shrinkVideo(file, load);
    expect(asked[0]?.video).toMatchObject({ width: 640, height: 360, frameRate: 24 });
  });

  it('gives back the encoded MP4', async () => {
    const shrunk = await shrinkVideo(file, videoTools().load);
    expect(shrunk?.type).toBe('video/mp4');
    expect(new Uint8Array((await shrunk?.arrayBuffer()) ?? [])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('gives nothing when this browser cannot make the video, so the original goes', async () => {
    const execute = vi.fn(() => Promise.resolve());
    expect(await shrinkVideo(file, videoTools({ isValid: false, execute }).load)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives nothing rather than lose the sound when this browser cannot encode it', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const { load } = videoTools({ discardedTracks: [{ reason: 'no_encodable_target_codec' }], execute });
    expect(await shrinkVideo(file, load)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives nothing for a file with no video track', async () => {
    expect(await shrinkVideo(file, videoTools({ track: null }).load)).toBeNull();
  });

  it('gives nothing when the library will not load', async () => {
    expect(await shrinkVideo(file, () => Promise.reject(new Error('offline')))).toBeNull();
  });

  it('gives nothing when encoding fails', async () => {
    const { load } = videoTools({ execute: () => Promise.reject(new Error('encoder died')) });
    expect(await shrinkVideo(file, load)).toBeNull();
  });

  it('stops an encoder that never finishes after two minutes, so the original goes', async () => {
    vi.useFakeTimers();
    const { cancel, load } = videoTools({ execute: () => new Promise<void>(() => undefined) });
    const shrinking = shrinkVideo(file, load);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await shrinking).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
