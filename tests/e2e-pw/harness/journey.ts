/**
 * The contact journey's helpers for the Playwright suite (shyden-labs/shydesk#176 PR 3): keys,
 * wheel and drag on the media viewer, the browser's own video controls, new pages, and contrast.
 * Each is a desktop port of its WebdriverIO helper (tests/e2e/harness/, tests/e2e/contact.e2e.ts),
 * reusing that suite's pure functions; every press is a real mouse or key event.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  contrastRatio,
  GRAPHIC_CONTRAST,
  gradientColours,
  LIST_PARTS,
  partShortfalls,
  TEXT_CONTRAST,
  type Part,
} from '../../e2e/harness/contrast.ts';
import { ownControlsPoints, videoControlPoint, viewportPoint, type Box } from '../../e2e/harness/targets.ts';
import { videoStateNote, WATCHED, type VideoState } from '../../e2e/harness/video.ts';
import { named, tap } from './input.ts';
import { JOURNEY_WAIT } from './read.ts';
import { targetForProject } from './targets.ts';

/** A browser's own video control the journey presses. */
export type VideoControl = 'pause' | 'scrub';

/** The keys the media viewer answers to (shyden-labs/shydesk#25). */
export type ViewerKey = 'Escape' | 'ArrowLeft' | 'ArrowRight' | 'r';

/** Where the element `locator` finds is drawn in the window, once it is on the page. */
async function boxOf(locator: Locator, label: string): Promise<Box> {
  const box = await locator.boundingBox({ timeout: JOURNEY_WAIT }).catch((error: unknown) => {
    throw new Error(`"${label}" never appeared`, { cause: error });
  });
  if (box === null) throw new Error(`"${label}" is not drawn`);
  return box;
}

/** The middle of where the element named `label` is drawn, failing if it lies outside the window. */
async function drawnCentre(page: Page, label: string): Promise<{ x: number; y: number }> {
  const box = await boxOf(named(page, label), label);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  return viewportPoint(box, viewport, label);
}

/** A real key press, sent to whatever has focus. */
export async function press(page: Page, key: ViewerKey): Promise<void> {
  await page.keyboard.press(key);
}

/** A real zoom in over the element named `label`: one wheel notch. */
export async function zoomIn(page: Page, label: string): Promise<void> {
  const at = await drawnCentre(page, label);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -120);
}

/** A real sideways mouse drag across the element named `label`, right to left. */
export async function swipeLeft(page: Page, label: string): Promise<void> {
  const at = await drawnCentre(page, label);
  await page.mouse.move(at.x + 80, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x - 80, at.y, { steps: 10 });
  await page.mouse.up();
}

/**
 * A real mouse click at the middle of where the element named `label` is drawn. Whatever a
 * person's click there would reach gets it, as a layer drawn over the element does (shyden-labs/shydesk#108).
 */
export async function clickMiddleOf(page: Page, label: string): Promise<void> {
  const at = await drawnCentre(page, label);
  await page.mouse.click(at.x, at.y);
}

/**
 * A real mouse press on the browser's own `control` over the video named `label` (shyden-labs/shydesk#108
 * AC2). The pointer rests there first, so a browser that hides its controls while playing shows them.
 */
export async function pressVideoControl(page: Page, label: string, control: VideoControl): Promise<void> {
  const box = await boxOf(named(page, label), label);
  const at = videoControlPoint(box, control, targetForProject(test.info().project.name));
  await page.mouse.move(at.x, at.y);
  // The rest a person's pointer makes before pressing, as the WebdriverIO helper's pause(500).
  await page.waitForTimeout(500);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * A real press on a link or a button that loads a new page, waiting until that page has loaded.
 */
export async function tapToNewPage(page: Page, label: string): Promise<void> {
  const loaded = page.waitForEvent('load', { timeout: JOURNEY_WAIT });
  await tap(page, label);
  await loaded.catch((error: unknown) => {
    throw new Error(`the press on "${label}" never loaded a new page`, { cause: error });
  });
}

/** Waits until the full-size picture named `label` has drawn. */
export async function pictureDrew(page: Page, label: string): Promise<void> {
  const picture = named(page, label);
  await expect
    .poll(() => picture.evaluate((element) => (element as HTMLImageElement).naturalWidth), {
      timeout: JOURNEY_WAIT,
      message: `"${label}" never drew`,
    })
    .toBeGreaterThan(0);
}

/** Waits until the picture inside the attachment preview button named `label` has drawn. */
export async function previewDrew(page: Page, label: string): Promise<void> {
  const preview = named(page, label);
  await expect
    .poll(() => preview.evaluate((element) => element.querySelector('img')?.naturalWidth ?? 0), {
      timeout: JOURNEY_WAIT,
      message: `the attachment preview "${label}" never drew`,
    })
    .toBeGreaterThan(0);
}

/** Waits until the page, shadow roots included, holds no media viewer: it closed. */
export async function viewerClosed(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Attachment viewer"]'), 'the media viewer never closed').toHaveCount(0, {
    timeout: JOURNEY_WAIT,
  });
}

/** Waits until the viewer's status says it is zoomed in past 100%. */
export async function zoomedIn(page: Page): Promise<void> {
  const status = named(page, 'Viewer status');
  let text = '';
  await expect
    .poll(
      async () => {
        text = await status.innerText();
        return Number(/zoom (\d+)%/.exec(text)?.[1] ?? 0);
      },
      { timeout: JOURNEY_WAIT, message: 'the viewer never zoomed in' },
    )
    .toBeGreaterThan(100)
    .catch((error: unknown) => {
      throw new Error(`the viewer never zoomed in; its status said "${text}"`, { cause: error });
    });
}

/** What lies at `x`, `y` on the video's own page or shadow root: "video" when it is the video itself. */
function hitAt(video: Locator, x: number, y: number): Promise<string> {
  return video.evaluate(
    (element, at) => {
      const root = element.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(at.x, at.y);
      return hit === element ? 'video' : String(hit?.className || hit?.tagName);
    },
    { x, y },
  );
}

/**
 * Fails unless every point where a browser draws its own video controls over the video named `label`
 * (its bottom bar, Chrome's button row, Safari's two top pills) is the video itself, not the drag layer.
 */
export async function ownControlsUncovered(page: Page, label: string): Promise<void> {
  const video = named(page, label);
  const box = await boxOf(video, label);
  for (const { at, where } of ownControlsPoints(box)) {
    const hit = await hitAt(video, at.x, at.y);
    expect(hit, `${where} of "${label}" at ${String(at.x)}, ${String(at.y)} is covered by "${hit}"`).toBe('video');
  }
}

/** Waits until the drag layer lies over the middle of the video named `label`, where its press is made. */
export async function pictureTakesPress(page: Page, label: string): Promise<void> {
  const video = named(page, label);
  let hit = 'nothing read';
  await expect
    .poll(
      async () => {
        const box = await boxOf(video, label);
        hit = await hitAt(video, box.x + box.width / 2, box.y + box.height / 2);
        return hit;
      },
      { timeout: JOURNEY_WAIT, message: `the middle of "${label}" never reached the drag layer` },
    )
    .toBe('drag-layer')
    .catch((error: unknown) => {
      throw new Error(`the middle of "${label}" never reached the drag layer; it reached "${hit}"`, { cause: error });
    });
}

/** The state of the video named `label`, read from the page. */
function videoState(page: Page, label: string): Promise<VideoState> {
  return named(page, label).evaluate((element) => {
    const v = element as HTMLVideoElement & { shydeskEvents?: string[] };
    return {
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      currentTime: v.currentTime,
      width: v.videoWidth,
      height: v.videoHeight,
      error: v.error ? v.error.code : null,
      playRefused: v.dataset['playRefused'] ?? null,
      events: v.shydeskEvents ?? [],
      connected: v.isConnected,
    };
  });
}

/**
 * Starts recording the media events of the video named `label` (shyden-labs/shydesk#188), so a play
 * that never starts says whether a pause, a fresh load or the element's removal aborted it.
 */
export async function watchVideo(page: Page, label: string): Promise<void> {
  await named(page, label).evaluate((element, types) => {
    const v = element as HTMLVideoElement & { shydeskEvents: string[] };
    v.shydeskEvents = [];
    for (const type of types) v.addEventListener(type, () => v.shydeskEvents.push(`${type}@${String(Math.round(performance.now()))}`));
  }, WATCHED);
}

/** DIAGNOSTIC ONLY (shyden-labs/shydesk#188), never merged: saves the stored video the viewer plays, for ffmpeg. */
async function saveVideo(page: Page, label: string, outcome: string): Promise<string> {
  const read = await named(page, label)
    .evaluate(async (element) => {
      const v = element as HTMLVideoElement;
      const bytes = new Uint8Array(await (await fetch(v.src)).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    })
    .catch((problem: unknown) => `ERR ${String(problem)}`);
  if (read.startsWith('ERR ')) return read;
  const dir = path.join('.e2e-runs', 'diag188');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `repeat${String(test.info().repeatEachIndex)}-${outcome}.mp4`);
  writeFileSync(file, Buffer.from(read, 'base64'));
  return `saved ${file}`;
}

/** Waits until `holds` is true of the video named `label`, failing with `what` and its last state. */
export async function untilVideo(page: Page, label: string, holds: (s: VideoState) => boolean, what: string): Promise<VideoState> {
  let last: VideoState | undefined;
  const sizing = what === 'the video never reported its size';
  await expect
    .poll(
      async () => {
        last = await videoState(page, label);
        return holds(last);
      },
      { timeout: JOURNEY_WAIT, message: what },
    )
    .toBe(true)
    .catch(async (error: unknown) => {
      const saved = sizing ? await saveVideo(page, label, 'stall') : '';
      console.log(`DIAG188 STALL MARK ${String(Date.now())}`);
      const again = sizing
        ? await named(page, label)
            .evaluate(async (element) => {
              const v = element as HTMLVideoElement;
              const watch = (media: HTMLVideoElement, ms: number) =>
                new Promise<string>((resolve) => {
                  const seen: string[] = [];
                  for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'error', 'stalled'])
                    media.addEventListener(type, () => seen.push(type));
                  setTimeout(() => {
                    resolve(
                      `readyState ${String(media.readyState)}, error ${String(media.error?.code ?? 'none')}, size ${String(media.videoWidth)}x${String(media.videoHeight)}, events ${seen.join(' ')}`,
                    );
                  }, ms);
                });
              const sameWait = watch(v, 8000);
              v.load();
              const same = await sameWait;
              const fresh = document.createElement('video');
              fresh.muted = true;
              fresh.preload = 'auto';
              const freshWait = watch(fresh, 8000);
              fresh.src = v.src;
              (v.getRootNode() as ShadowRoot | Document).querySelector('div')?.append(fresh);
              const other = await freshWait;
              return `same element load(): ${same}; fresh element: ${other}`;
            })
            .catch((problem: unknown) => `second load not tried: ${String(problem)}`)
        : '';
      throw new Error(
        `${what}: ${last === undefined ? `"${label}" was never read` : videoStateNote(label, last)}; DIAG188 ${saved}; ${again}`,
        {
          cause: error,
        },
      );
    });
  if (sizing) console.log(`DIAG188 ${await saveVideo(page, label, 'ok')}`);
  return last as VideoState;
}

/**
 * Fails, naming every shortfall at once, unless each field named in `labels` shows its text
 * at 4.5:1 against its own background and, for a select, draws its arrow at 3:1.
 */
export async function readable(page: Page, labels: readonly string[]): Promise<void> {
  const short: string[] = [];
  for (const label of labels) {
    const style = await named(page, label).evaluate((element) => {
      const s = getComputedStyle(element);
      return { tag: element.tagName, color: s.color, background: s.backgroundColor, image: s.backgroundImage };
    });
    const text = contrastRatio(style.color, style.background);
    if (text < TEXT_CONTRAST) short.push(`"${label}" text ${style.color} on ${style.background} is ${text.toFixed(2)}:1`);
    if (style.tag === 'SELECT') {
      const arrow = gradientColours(style.image).filter((colour) => !/^rgba\(.*,\s*0\)$/.test(colour));
      if (arrow.length === 0) short.push(`"${label}" draws no arrow (${style.image})`);
      for (const colour of arrow) {
        const ratio = contrastRatio(colour, style.background);
        if (ratio < GRAPHIC_CONTRAST) short.push(`"${label}" arrow ${colour} on ${style.background} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  expect(short, `under WCAG contrast: ${short.join('; ')}`).toEqual([]);
}

/** Fails, naming every shortfall at once, unless every shown word and field border on the form meets WCAG contrast. */
export async function everyPartReadable(page: Page): Promise<void> {
  const parts = await page.evaluate<Part[]>(`(() => {${LIST_PARTS}})()`);
  const short = partShortfalls(parts);
  expect(short, `under WCAG contrast: ${short.join('; ')}`).toEqual([]);
}

/** The size in KB of each attached file, once two are attached. */
export async function attachedTwo(page: Page): Promise<number[]> {
  const element = named(page, 'Attachments');
  let sizes: number[] = [];
  await expect
    .poll(
      async () => {
        sizes = [...(await element.innerText()).matchAll(/attached, (\d+) KB/g)].map((m) => Number(m[1]));
        return sizes.length;
      },
      { timeout: 150_000, message: 'two attachments never finished uploading' },
    )
    .toBe(2);
  return sizes;
}

/** Waits until the button named `label` is enabled again: the check handed over a new token. */
export async function sendEnabled(page: Page, label: string): Promise<void> {
  await expect(named(page, label), 'the check never handed over a new token').toBeEnabled({ timeout: JOURNEY_WAIT });
}

/** Waits until the desk's unread badge shows a count, once its first request is back. */
export async function unreadCounted(page: Page): Promise<void> {
  await expect(named(page, 'Unread tickets'), 'the unread badge never showed a count').toHaveText(/^\d+$/, { timeout: JOURNEY_WAIT });
}
