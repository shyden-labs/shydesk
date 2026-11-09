import { describe, expect, it } from 'vitest';
import { START, next, prev, rotate, stateLine, wheelFactor, zoomBy } from '../../public/embed-viewer.js';

// The media viewer's state (shyden-labs/shydesk#25 AC1): zoom clamped 1-8,
// rotation cycling in quarter turns, next and previous wrapping round.
describe('zoomBy', () => {
  it('multiplies the zoom by the factor', () => {
    expect(zoomBy(START, 2, 0, 0).zoom).toBe(2);
  });

  it('never goes past 8', () => {
    expect(zoomBy({ ...START, zoom: 6 }, 2, 0, 0).zoom).toBe(8);
  });

  it('never goes below 1, and back at 1 the picture is centred again', () => {
    const out = zoomBy({ ...START, zoom: 2, panX: 40, panY: -30 }, 0.25, 10, 10);
    expect(out).toEqual({ ...START, zoom: 1 });
  });

  it('keeps the point under the pointer still while zooming in', () => {
    // Pointer 100 px right and 50 px below the centre: at 2x that point would move to 200, 100, so the picture shifts back.
    const out = zoomBy(START, 2, 100, 50);
    expect(out).toMatchObject({ zoom: 2, panX: -100, panY: -50 });
  });

  it('keeps the point still from a zoom already panned', () => {
    // A point at (cx - pan) / zoom in the picture stays under cx.
    const out = zoomBy({ ...START, zoom: 2, panX: -100, panY: -50 }, 2, 100, 50);
    expect(out).toMatchObject({ zoom: 4, panX: -300, panY: -150 });
  });

  it('does not move the picture when the zoom is already at its limit', () => {
    const at = { ...START, zoom: 8, panX: 12, panY: 34 };
    expect(zoomBy(at, 2, 100, 100)).toEqual(at);
  });

  it('keeps the index and rotation', () => {
    expect(zoomBy({ ...START, index: 2, rotation: 90 }, 2, 0, 0)).toMatchObject({ index: 2, rotation: 90 });
  });
});

describe('rotate', () => {
  it('turns a quarter clockwise', () => {
    expect(rotate(START, 1).rotation).toBe(90);
  });

  it('comes back to 0 after four turns', () => {
    let s = START;
    for (const expected of [90, 180, 270, 0]) {
      s = rotate(s, 1);
      expect(s.rotation).toBe(expected);
    }
  });

  it('turns anticlockwise from 0 to 270', () => {
    expect(rotate(START, -1).rotation).toBe(270);
  });

  it('keeps the zoom, pan and index', () => {
    const at = { ...START, index: 1, zoom: 3, panX: 5, panY: 6 };
    expect(rotate(at, 1)).toEqual({ ...at, rotation: 90 });
  });
});

describe('next and prev', () => {
  const turned = { index: 1, zoom: 4, rotation: 180 as const, panX: 7, panY: 8 };

  it('next moves on one and starts the new file unzoomed and upright', () => {
    expect(next(turned, 3)).toEqual({ ...START, index: 2 });
  });

  it('next wraps from the last file to the first', () => {
    expect(next({ ...START, index: 2 }, 3).index).toBe(0);
  });

  it('prev moves back one and starts the file unzoomed and upright', () => {
    expect(prev(turned, 3)).toEqual({ ...START, index: 0 });
  });

  it('prev wraps from the first file to the last', () => {
    expect(prev(START, 3).index).toBe(2);
  });

  it('with one file, both stay on it', () => {
    expect(next(START, 1).index).toBe(0);
    expect(prev(START, 1).index).toBe(0);
  });
});

describe('stateLine', () => {
  it('names the kind, the place, the zoom and the rotation', () => {
    expect(stateLine({ ...START, index: 1, zoom: 2, rotation: 180 }, 3, 'Photo')).toBe('Photo 2 of 3, zoom 200%, rotated 180°');
  });

  it('rounds the zoom to a whole percent', () => {
    expect(stateLine(zoomBy(START, 1.25 * 1.25, 0, 0), 1, 'Video')).toBe('Video 1 of 1, zoom 156%, rotated 0°');
  });
});

// A wheel zooms by how far it turned, not by how many events carried it:
// Firefox splits one notch into several (CI run 42677193362 reached 381%).
describe('wheelFactor', () => {
  it('zooms in by a quarter for one 120 px notch toward the screen, and out by the same away', () => {
    expect(wheelFactor(-120, 0, 800)).toBeCloseTo(1.25, 10);
    expect(wheelFactor(120, 0, 800)).toBeCloseTo(0.8, 10);
  });

  it('gives the same zoom however the notch is split into events', () => {
    const split = [-20, -20, -20, -20, -20, -20].reduce((zoom, delta) => zoom * wheelFactor(delta, 0, 800), 1);
    expect(split).toBeCloseTo(1.25, 10);
  });

  it('counts a line as 16 px and a page as the stage height', () => {
    expect(wheelFactor(-7.5, 1, 800)).toBeCloseTo(1.25, 10);
    expect(wheelFactor(-0.15, 2, 800)).toBeCloseTo(1.25, 10);
  });

  it('leaves the zoom alone for a sideways-only wheel', () => {
    expect(wheelFactor(0, 0, 800)).toBe(1);
  });
});
