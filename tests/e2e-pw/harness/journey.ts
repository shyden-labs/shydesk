/**
 * The contact journey's helpers for the Playwright suite (shyden-labs/shydesk#176 PR 3): keys,
 * wheel and drag on the media viewer, the browser's own video controls, new pages, and contrast.
 * Stubs until each is ported, so the journey shows red on CI by name first.
 */
import type { Page } from '@playwright/test';
import type { VideoState } from '../../e2e/harness/video.ts';

/** A browser's own video control the journey presses. */
export type VideoControl = 'pause' | 'scrub';

const notPorted = (helper: string, page: Page): Promise<never> => Promise.reject(new Error(`not ported: ${helper} on ${page.url()}`));

export const press = (page: Page, key: string): Promise<void> => notPorted(`press ${key}`, page);
export const zoomIn = (page: Page, label: string): Promise<void> => notPorted(`zoomIn ${label}`, page);
export const zoomedIn = (page: Page): Promise<void> => notPorted('zoomedIn', page);
export const swipeLeft = (page: Page, label: string): Promise<void> => notPorted(`swipeLeft ${label}`, page);
export const clickMiddleOf = (page: Page, label: string): Promise<void> => notPorted(`clickMiddleOf ${label}`, page);
export const pressVideoControl = (page: Page, label: string, control: VideoControl): Promise<void> =>
  notPorted(`pressVideoControl ${label} ${control}`, page);
export const tapToNewPage = (page: Page, label: string): Promise<void> => notPorted(`tapToNewPage ${label}`, page);
export const pictureDrew = (page: Page, label: string): Promise<void> => notPorted(`pictureDrew ${label}`, page);
export const previewDrew = (page: Page, label: string): Promise<void> => notPorted(`previewDrew ${label}`, page);
export const viewerClosed = (page: Page): Promise<void> => notPorted('viewerClosed', page);
export const ownControlsUncovered = (page: Page, label: string): Promise<void> => notPorted(`ownControlsUncovered ${label}`, page);
export const pictureTakesPress = (page: Page, label: string): Promise<void> => notPorted(`pictureTakesPress ${label}`, page);
export const watchVideo = (page: Page, label: string): Promise<void> => notPorted(`watchVideo ${label}`, page);
export const untilVideo = (page: Page, label: string, holds: (s: VideoState) => boolean, what: string): Promise<VideoState> =>
  notPorted(`untilVideo ${label} ${what} ${String(holds.length)}`, page);
export const readable = (page: Page, labels: readonly string[]): Promise<void> => notPorted(`readable ${labels.join(', ')}`, page);
export const everyPartReadable = (page: Page): Promise<void> => notPorted('everyPartReadable', page);
export const attachedTwo = (page: Page): Promise<number[]> => notPorted('attachedTwo', page);
export const sendEnabled = (page: Page, label: string): Promise<void> => notPorted(`sendEnabled ${label}`, page);
export const unreadCounted = (page: Page): Promise<void> => notPorted('unreadCounted', page);
