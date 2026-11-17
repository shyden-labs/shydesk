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
  atCentre: 'VIDEO "Video 1 full size"',
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
      '"Video 1 full size": readyState 1 (metadata), networkState 2 (loading), playing asked, time 0.00 s, size 0×0, error none, play never refused, under its centre VIDEO "Video 1 full size"',
    );
  });

  it('names a media error by its code', () => {
    expect(videoStateNote('v', state({ readyState: 0, networkState: 3, paused: true, error: 4 }))).toBe(
      '"v": readyState 0 (nothing), networkState 3 (no source), paused, time 0.50 s, size 1920×1080, error 4 (source not supported), play never refused, under its centre VIDEO "Video 1 full size"',
    );
  });

  // shyden-labs/shydesk#188 AC2: a video left paused after the click says whether play was refused, and why, and
  // what the click at its centre landed on.
  it('names a refused play and what lies under the centre', () => {
    expect(
      videoStateNote('v', state({ paused: true, currentTime: 0, playRefused: 'NotAllowedError: denied', atCentre: 'DIV "Viewer stage"' })),
    ).toBe(
      '"v": readyState 4 (enough data), networkState 1 (idle), paused, time 0.00 s, size 1920×1080, error none, play refused NotAllowedError: denied, under its centre DIV "Viewer stage"',
    );
  });
});
