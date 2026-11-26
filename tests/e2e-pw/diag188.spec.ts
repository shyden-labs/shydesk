import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * DIAGNOSTIC (shyden-labs/shydesk#188), removed before merge: what stops WebKit playing its own
 * re-encode in the ticket viewer, when it plays the same file at once on a blank page. Each case is a
 * fresh <video> playing a blob: URL, as the viewer does; it logs only and asserts nothing.
 */
const CASES: { file: string; attrs: Record<string, string>; muted: boolean }[] = [
  // The viewer's own element (public/embed-viewer.js): controls, playsinline, preload=metadata, sound on.
  { file: 'webkit.mp4', attrs: { controls: '', playsinline: '', preload: 'metadata' }, muted: false },
  // One change at a time from the viewer's element.
  { file: 'webkit.mp4', attrs: { controls: '', playsinline: '', preload: 'metadata' }, muted: true },
  { file: 'webkit.mp4', attrs: { controls: '', playsinline: '', preload: 'auto' }, muted: false },
  { file: 'webkit.mp4', attrs: { playsinline: '', preload: 'metadata' }, muted: false },
  // Last run's blank-page element: no attributes, muted.
  { file: 'webkit.mp4', attrs: {}, muted: true },
  // The sound alone, and the picture alone, in the viewer's element.
  { file: 'd-audio-only.mp4', attrs: { controls: '', playsinline: '', preload: 'metadata' }, muted: false },
  { file: 'a-video-only.mp4', attrs: { controls: '', playsinline: '', preload: 'metadata' }, muted: false },
  { file: 'a-video-only.mp4', attrs: {}, muted: true },
  { file: 'c-video-high.mp4', attrs: {}, muted: true },
  { file: '../ok-10s.mp4', attrs: { controls: '', playsinline: '', preload: 'metadata' }, muted: false },
];

test('diagnostic: how each browser plays WebKit re-encode in the viewer element', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setContent('<!doctype html><title>diag</title><main></main>');
  for (const { file, attrs, muted } of CASES) {
    const base64 = readFileSync(`tests/fixtures/media/diag188/${file}`).toString('base64');
    const state = await page.evaluate(
      async ({ data, attrs, muted }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const main = document.querySelector('main') as HTMLElement;
        main.replaceChildren();
        const video = document.createElement('video');
        for (const [name, value] of Object.entries(attrs)) video.setAttribute(name, value);
        video.muted = muted;
        main.append(video);
        const events: string[] = [];
        for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'stalled', 'error', 'suspend', 'waiting']) {
          video.addEventListener(type, () => events.push(type));
        }
        video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
        const started = performance.now();
        while (video.readyState < 1 && video.error === null && performance.now() - started < 15_000) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return {
          readyState: video.readyState,
          networkState: video.networkState,
          error: video.error ? `${String(video.error.code)} ${video.error.message}` : null,
          size: `${String(video.videoWidth)}x${String(video.videoHeight)}`,
          ms: Math.round(performance.now() - started),
          events: [...new Set(events)].join(','),
        };
      },
      { data: base64, attrs, muted },
    );
    console.log(`[188 ${test.info().project.name}] case ${file} ${JSON.stringify(attrs)} muted=${String(muted)} ${JSON.stringify(state)}`);
  }
});
