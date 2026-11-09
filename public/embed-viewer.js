/// <reference lib="dom" />
/**
 * The read-only media viewer (shyden-labs/shydesk#25; plan Task 11), used by
 * the staff desk and by the shared piece's ticket view. It opens a ticket's
 * photos and videos full size with zoom, rotate and next/previous, and has no
 * control that changes a file: files only ever come from the read routes.
 *
 * A plain module, typed with JSDoc and checked by `tsc`, so it ships as written.
 */

/** @typedef {0 | 90 | 180 | 270} Rotation */
/** @typedef {{ index: number, zoom: number, rotation: Rotation, panX: number, panY: number }} ViewerState */

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

/** A file opened fresh: unzoomed, upright and centred. */
export const START = /** @type {ViewerState} */ (Object.freeze({ index: 0, zoom: 1, rotation: 0, panX: 0, panY: 0 }));

/**
 * The zoom times `factor`, held to 1-8, keeping the picture's point under
 * (`cx`, `cy`) (measured from the stage's centre) where it is. Back at 1 the
 * picture is centred again.
 * @param {ViewerState} s
 * @param {number} factor
 * @param {number} cx
 * @param {number} cy
 * @returns {ViewerState}
 */
export function zoomBy(s, factor, cx, cy) {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.zoom * factor));
  if (zoom === MIN_ZOOM) return { ...s, zoom, panX: 0, panY: 0 };
  const scale = zoom / s.zoom;
  return { ...s, zoom, panX: cx - (cx - s.panX) * scale, panY: cy - (cy - s.panY) * scale };
}

/**
 * A quarter turn clockwise (1) or anticlockwise (-1).
 * @param {ViewerState} s
 * @param {1 | -1} dir
 * @returns {ViewerState}
 */
export function rotate(s, dir) {
  return { ...s, rotation: /** @type {Rotation} */ ((s.rotation + 90 * dir + 360) % 360) };
}

/**
 * The next of `count` files, after the last the first, opened fresh.
 * @param {ViewerState} s
 * @param {number} count
 * @returns {ViewerState}
 */
export function next(s, count) {
  return { ...START, index: (s.index + 1) % count };
}

/**
 * The previous of `count` files, before the first the last, opened fresh.
 * @param {ViewerState} s
 * @param {number} count
 * @returns {ViewerState}
 */
export function prev(s, count) {
  return { ...START, index: (s.index - 1 + count) % count };
}

/**
 * What the viewer shows, in words, for its status line.
 * @param {ViewerState} s
 * @param {number} count
 * @param {string} kind "Photo" or "Video"
 */
export function stateLine(s, count, kind) {
  return `${kind} ${String(s.index + 1)} of ${String(count)}, zoom ${String(Math.round(s.zoom * 100))}%, rotated ${String(s.rotation)}°`;
}
