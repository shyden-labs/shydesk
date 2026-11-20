import { describe, it, expect } from 'vitest';
import { playing, sizeKnown, videoStateNote, type VideoState } from '../../tests/e2e/harness/video.ts';

/**
 * What the journey reads from a video before it judges it (shyden-labs/shydesk#188): its size only
 * once the metadata has loaded, "playing" only once time has moved, and every failure names the
 * element's whole state.
 */
const state = (over: Partial<VideoState> = {}): VideoState => ({
  readyState: 4,
  networkState: 1,
  paused: false,
  currentTime: 0.5,
  width: 1920,
  height: 1080,
  error: null,
  playRefused: null,
  events: [],
  connected: true,
  ...over,
});

describe('sizeKnown', () => {
  it('is true once the metadata has loaded and the size is set', () => {
    expect(sizeKnown(state({ readyState: 1 }))).toBe(true);
  });

  it('is false before the metadata has loaded, even when asked to play', () => {
    expect(sizeKnown(state({ readyState: 0, width: 0, height: 0 }))).toBe(false);
  });

  it('is false before the metadata has loaded, whatever the size reads', () => {
    expect(sizeKnown(state({ readyState: 0 }))).toBe(false);
  });

  it('is false while the size still reads 0', () => {
    expect(sizeKnown(state({ readyState: 1, width: 0, height: 0 }))).toBe(false);
  });
});

describe('playing', () => {
  it('is true once play was asked for and time has moved', () => {
    expect(playing(state())).toBe(true);
  });

  it('is false when play was asked for but no time has passed yet', () => {
    expect(playing(state({ currentTime: 0 }))).toBe(false);
  });

  it('is false while paused', () => {
    expect(playing(state({ paused: true }))).toBe(false);
  });
});

describe('videoStateNote', () => {
  it('names every part of the state, with the browser meaning of each number', () => {
    expect(videoStateNote('Video 1 full size', state({ readyState: 1, networkState: 2, currentTime: 0, width: 0, height: 0 }))).toBe(
      '"Video 1 full size": readyState 1 (metadata), networkState 2 (loading), playing asked, time 0.00 s, size 0×0, error none, play refused none, events none',
    );
  });

  it('names a media error by its code', () => {
    expect(videoStateNote('v', state({ readyState: 0, networkState: 3, paused: true, error: 4 }))).toBe(
      '"v": readyState 0 (nothing), networkState 3 (no source), paused, time 0.50 s, size 1920×1080, error 4 (source not supported), play refused none, events none',
    );
  });

  it('names the reason a play was refused', () => {
    expect(
      videoStateNote(
        'v',
        state({ readyState: 1, paused: true, currentTime: 0, playRefused: 'NotAllowedError: The request is not allowed' }),
      ),
    ).toBe(
      '"v": readyState 1 (metadata), networkState 1 (idle), paused, time 0.00 s, size 1920×1080, error none, play refused NotAllowedError: The request is not allowed, events none',
    );
  });

  it('lists the media events seen since the watch began, in order, with their times', () => {
    expect(videoStateNote('v', state({ events: ['loadstart@10', 'loadedmetadata@42', 'play@900', 'pause@903'] }))).toMatch(
      /, events loadstart@10 loadedmetadata@42 play@900 pause@903$/,
    );
  });

  it('says when the element is no longer on the page', () => {
    expect(videoStateNote('v', state({ connected: false }))).toMatch(/, events none, removed from the page$/);
  });
});
