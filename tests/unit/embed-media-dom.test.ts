// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shrinkImage, thumbnailOf, videoSeconds } from '../../public/embed-media.js';

// The shared piece's drawing (shyden-labs/shydesk#21): photos and video frames drawn
// on a canvas and saved as JPEG, and the video element that reports a video's length.
// A unit run has no real decoder or canvas, so each is stood in: the tests check what
// is asked of them and what comes back. The real drawing is the e2e suite's.

type Drawn = { canvas: HTMLCanvasElement; options: unknown; draws: unknown[][]; saved: unknown[][] };

/** Gives every new canvas a recording 2D context, or none when `context` is false. */
function standInCanvas({ context = true, blob = new Blob(['jpeg'], { type: 'image/jpeg' }) } = {}): Drawn[] {
  const drawn: Drawn[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    _kind: string,
    options?: unknown,
  ) {
    const one: Drawn = { canvas: this, options, draws: [], saved: [] };
    drawn.push(one);
    if (!context) return null;
    return {
      drawImage: (...args: unknown[]) => {
        one.draws.push(args);
      },
    } as never;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    done: BlobCallback,
    type?: string,
    quality?: unknown,
  ) {
    drawn.at(-1)?.saved.push([type, quality]);
    done(blob);
  });
  return drawn;
}

function standInBitmap(width: number, height: number) {
  const bitmap = { width, height };
  const asked: unknown[] = [];
  vi.stubGlobal('createImageBitmap', (file: unknown) => {
    asked.push(file);
    return Promise.resolve(bitmap);
  });
  return { bitmap, asked };
}

/** Captures the video element the code makes, and the object URLs it opens and closes. */
function standInVideo() {
  const created = vi.spyOn(document, 'createElement');
  const made = {
    get length() {
      return created.mock.results.filter((one) => one.value instanceof HTMLVideoElement).length;
    },
    get first() {
      return created.mock.results.find((one) => one.value instanceof HTMLVideoElement)?.value as HTMLVideoElement;
    },
  };
  const revoked: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stand-in');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
  });
  /** Waits for the element, gives it the values a decoder would, then fires `event`. */
  const fire = async (event: string, values: Record<string, number> = {}) => {
    await vi.waitFor(() => {
      expect(made).toHaveLength(1);
    });
    const video = made.first;
    for (const [name, value] of Object.entries(values)) Object.defineProperty(video, name, { value });
    video.dispatchEvent(new Event(event));
    return video;
  };
  return { made, revoked, fire };
}

const photo = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
const clip = new File(['clip'], 'clip.mp4', { type: 'video/mp4' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shrinkImage', () => {
  it('draws the photo at its planned size on a software canvas and saves a JPEG at 0.85', async () => {
    const drawn = standInCanvas();
    const { bitmap, asked } = standInBitmap(4000, 3000);
    const jpeg = await shrinkImage(photo);
    expect(asked).toEqual([photo]);
    expect(await jpeg?.text()).toBe('jpeg');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.canvas.width).toBe(2560);
    expect(drawn[0]?.canvas.height).toBe(1920);
    expect(drawn[0]?.options).toEqual({ willReadFrequently: true });
    expect(drawn[0]?.draws).toEqual([[bitmap, 0, 0, 2560, 1920]]);
    expect(drawn[0]?.saved).toEqual([['image/jpeg', 0.85]]);
  });

  it('gives nothing when this browser has no canvas to draw on', async () => {
    standInCanvas({ context: false });
    standInBitmap(100, 100);
    expect(await shrinkImage(photo)).toBeNull();
  });

  it('gives nothing when this browser cannot open the photo', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('not a picture')));
    expect(await shrinkImage(photo)).toBeNull();
  });
});

describe('thumbnailOf', () => {
  it('draws a photo with its long edge at 320 px and saves a JPEG at 0.8', async () => {
    const drawn = standInCanvas();
    const { bitmap } = standInBitmap(4000, 3000);
    expect(await (await thumbnailOf(photo, 'image'))?.text()).toBe('jpeg');
    expect(drawn[0]?.draws).toEqual([[bitmap, 0, 0, 320, 240]]);
    expect(drawn[0]?.saved).toEqual([['image/jpeg', 0.8]]);
  });

  it('never makes a small photo bigger', async () => {
    const drawn = standInCanvas();
    const { bitmap } = standInBitmap(200, 100);
    await thumbnailOf(photo, 'image');
    expect(drawn[0]?.draws).toEqual([[bitmap, 0, 0, 200, 100]]);
  });

  it('keeps a hair-thin photo at least 1 px wide', async () => {
    const drawn = standInCanvas();
    const { bitmap } = standInBitmap(1, 4000);
    await thumbnailOf(photo, 'image');
    expect(drawn[0]?.draws).toEqual([[bitmap, 0, 0, 1, 320]]);
  });

  it('draws the first frame of a video, once it has loaded, at 320 px', async () => {
    const drawn = standInCanvas();
    const video = standInVideo();
    const making = thumbnailOf(clip, 'video');
    const element = await video.fire('loadeddata', { videoWidth: 1080, videoHeight: 1920 });
    expect(await (await making)?.text()).toBe('jpeg');
    expect(element.muted).toBe(true);
    expect(element.playsInline).toBe(true);
    expect(element.getAttribute('preload')).toBe('auto');
    expect(element.src).toBe('blob:stand-in');
    expect(drawn[0]?.draws).toEqual([[element, 0, 0, 180, 320]]);
    expect(video.revoked).toEqual(['blob:stand-in']);
  });

  it('gives nothing when this browser cannot open the photo', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('not a picture')));
    expect(await thumbnailOf(photo, 'image')).toBeNull();
  });

  it('gives nothing when this browser reports an error on the video', async () => {
    standInCanvas();
    const video = standInVideo();
    const making = thumbnailOf(clip, 'video');
    await video.fire('error');
    expect(await making).toBeNull();
    expect(video.revoked).toEqual(['blob:stand-in']);
  });
});

describe('videoSeconds', () => {
  it('gives the length the browser reads from the video', async () => {
    const video = standInVideo();
    const reading = videoSeconds(clip);
    await video.fire('loadedmetadata', { duration: 29.5 });
    expect(await reading).toBe(29.5);
    expect(video.revoked).toEqual(['blob:stand-in']);
  });

  it('gives nothing when the browser cannot tell the length', async () => {
    const video = standInVideo();
    const reading = videoSeconds(clip);
    await video.fire('loadedmetadata', { duration: Number.POSITIVE_INFINITY });
    expect(await reading).toBeNull();
  });

  it('gives nothing when the browser says nothing within 5 s', async () => {
    vi.useFakeTimers();
    const video = standInVideo();
    let answer: number | null | undefined;
    void videoSeconds(clip).then((seconds) => {
      answer = seconds;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBeNull();
    expect(video.revoked).toEqual(['blob:stand-in']);
  });
});
