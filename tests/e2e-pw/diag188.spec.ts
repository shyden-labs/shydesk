import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * DIAGNOSTIC (shyden-labs/shydesk#188), removed before merge: which part of WebKit's own re-encode
 * its player cannot play. Each file is WebKit's stored copy or one variant of it (made with ffmpeg),
 * played from a blob: URL as the ticket page plays it. It logs only and asserts nothing.
 */
const FILES = ['webkit.mp4', 'a-video-only.mp4', 'b-no-editlist.mp4', 'c-video-high.mp4', 'd-audio-only.mp4', '../ok-10s.mp4'];

test('diagnostic: how each browser plays WebKit re-encode and its variants', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setContent('<!doctype html><title>diag</title><video muted playsinline></video>');
  for (const file of FILES) {
    const base64 = readFileSync(`tests/fixtures/media/diag188/${file}`).toString('base64');
    const state = await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const video = document.querySelector('video') as HTMLVideoElement;
      const events: string[] = [];
      for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'stalled', 'error', 'suspend', 'waiting']) {
        video.addEventListener(type, () => events.push(type));
      }
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      video.load();
      const started = performance.now();
      while (video.readyState < 2 && video.error === null && performance.now() - started < 20_000) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return {
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error ? `${String(video.error.code)} ${video.error.message}` : null,
        size: `${String(video.videoWidth)}x${String(video.videoHeight)}`,
        duration: video.duration,
        ms: Math.round(performance.now() - started),
        events: [...new Set(events)].join(','),
      };
    }, base64);
    console.log(`[188 ${test.info().project.name}] variant ${file} ${JSON.stringify(state)}`);
  }
});
