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

/** One wheel notch, or one press of a zoom control, zooms by this much. */
const ZOOM_STEP = 1.25;
/** A one-pointer move this far sideways (and more sideways than up or down), unzoomed, changes file. */
const SWIPE_PX = 50;

const VIEWER_CSS = `
.shydesk-viewer{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;background:rgba(0,0,0,.92);color:#fff;font:16px/1.4 system-ui,sans-serif}
.shydesk-viewer .controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px}
.shydesk-viewer button{min-width:44px;min-height:44px;padding:0 12px;border:1px solid #fff;border-radius:8px;background:#222;color:#fff;font:inherit;cursor:pointer}
.shydesk-viewer button:focus-visible{outline:3px solid #8cf;outline-offset:2px}
.shydesk-viewer .line{flex:1 1 14em;margin:0 8px}
.shydesk-viewer .stage{position:relative;flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}
.shydesk-viewer .stage>img,.shydesk-viewer .stage>video{max-width:100%;max-height:100%;transform-origin:center;user-select:none;-webkit-user-select:none}
`;

/**
 * @typedef {object} ViewerFile
 * @property {string} mime the stored type; a video plays with the browser's own controls
 * @property {() => Promise<string>} load the address to show it from, asked for when it is shown
 */

/**
 * Opens the read-only viewer over the page on `items[start]`. The wheel, two
 * fingers and the zoom controls zoom; `r`, `R` and the rotate controls turn;
 * the arrow keys, a sideways drag or swipe, and the controls move between
 * files; Esc and "Close viewer" close it and give focus back. Nothing in it
 * can change a file.
 * @param {{ doc: Document, host: Node, items: ViewerFile[], start: number, onClose?: () => void }} options
 *   `host` holds the overlay: the page's body, or the shared piece's shadow root.
 * @returns {{ close: () => void }}
 */
export function openViewer({ doc, host, items, start, onClose }) {
  const count = items.length;
  // Inside the piece's shadow root, the document only knows the piece itself has focus.
  const returnFocus = host instanceof ShadowRoot ? host.activeElement : doc.activeElement;
  /** @type {ViewerState} */
  let state = { ...START, index: start };
  /** @type {HTMLImageElement | HTMLVideoElement | null} */
  let shown = null;

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {Record<string, string>} attributes
   * @returns {HTMLElementTagNameMap[K]}
   */
  const el = (tag, attributes = {}) => {
    const element = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };

  const overlay = el('div', {
    class: 'shydesk-viewer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Attachment viewer',
    tabindex: '-1',
  });
  const css = el('style');
  css.textContent = VIEWER_CSS;
  const controls = el('div', { class: 'controls' });
  const line = el('p', { class: 'line', role: 'status', 'aria-label': 'Viewer status' });
  const stage = el('div', { class: 'stage', 'aria-label': 'Viewer stage' });

  const kindOf = (/** @type {number} */ index) => (items[index]?.mime.startsWith('video/') ? 'Video' : 'Photo');

  /** Applies `target` to what is shown and to the status line. */
  const apply = (/** @type {ViewerState} */ target) => {
    state = target;
    line.textContent = stateLine(state, count, kindOf(state.index));
    if (shown !== null) {
      shown.style.transform = `translate(${String(state.panX)}px, ${String(state.panY)}px) scale(${String(state.zoom)}) rotate(${String(state.rotation)}deg)`;
    }
  };

  /** Shows the file `target` points at, fresh. */
  const showFile = (/** @type {ViewerState} */ target) => {
    const file = items[target.index];
    if (file === undefined) return;
    const name = `${kindOf(target.index)} ${String(target.index + 1)} full size`;
    const media = file.mime.startsWith('video/')
      ? el('video', { controls: '', playsinline: '', preload: 'metadata', 'aria-label': name })
      : el('img', { alt: name, 'aria-label': name, draggable: 'false' });
    shown = media;
    stage.replaceChildren(media);
    apply(target);
    file.load().then(
      (address) => {
        if (shown === media) media.src = address;
      },
      () => {
        if (shown === media) line.textContent = `${name} could not be loaded.`;
      },
    );
  };

  const zoomStep = (/** @type {number} */ factor) => {
    apply(zoomBy(state, factor, 0, 0));
  };
  /** @type {[string, () => void][]} */
  const actions = [
    [
      'Previous',
      () => {
        showFile(prev(state, count));
      },
    ],
    [
      'Next',
      () => {
        showFile(next(state, count));
      },
    ],
    [
      'Zoom out',
      () => {
        zoomStep(1 / ZOOM_STEP);
      },
    ],
    [
      'Zoom in',
      () => {
        zoomStep(ZOOM_STEP);
      },
    ],
    [
      'Rotate left',
      () => {
        apply(rotate(state, -1));
      },
    ],
    [
      'Rotate right',
      () => {
        apply(rotate(state, 1));
      },
    ],
    [
      'Close viewer',
      () => {
        close();
      },
    ],
  ];
  for (const [label, act] of actions) {
    const button = el('button', { type: 'button' });
    button.textContent = label;
    button.addEventListener('click', act);
    controls.append(button);
  }
  controls.append(line);
  overlay.append(css, controls, stage);

  /** A point on screen, measured from the middle of the stage, where zooming keeps the picture still. */
  const fromMiddle = (/** @type {number} */ x, /** @type {number} */ y) => {
    const box = stage.getBoundingClientRect();
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
  };

  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const at = fromMiddle(event.clientX, event.clientY);
      apply(zoomBy(state, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, at.x, at.y));
    },
    { passive: false },
  );

  /** Pointers down on the stage (fingers or a mouse button), where each last was. */
  /** @type {Map<number, { x: number, y: number }>} */
  const pointers = new Map();
  /** Where a one-pointer drag on an unzoomed file began; null once it cannot be a swipe. */
  /** @type {{ x: number, y: number } | null} */
  let swipeStart = null;

  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    swipeStart = pointers.size === 1 && state.zoom === 1 ? { x: event.clientX, y: event.clientY } : null;
  });

  stage.addEventListener('pointermove', (event) => {
    const last = pointers.get(event.pointerId);
    if (last === undefined) return;
    const now = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, now);
    if (pointers.size === 2) {
      const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
      if (other === undefined) return;
      const before = Math.hypot(last.x - other.x, last.y - other.y);
      if (before === 0) return;
      const middle = fromMiddle((now.x + other.x) / 2, (now.y + other.y) / 2);
      apply(zoomBy(state, Math.hypot(now.x - other.x, now.y - other.y) / before, middle.x, middle.y));
    } else if (pointers.size === 1 && state.zoom > 1) {
      apply({ ...state, panX: state.panX + now.x - last.x, panY: state.panY + now.y - last.y });
    }
  });

  const lift = (/** @type {PointerEvent} */ event) => {
    if (!pointers.delete(event.pointerId)) return;
    const from = swipeStart;
    if (pointers.size > 0 || from === null || event.type === 'pointercancel') {
      if (pointers.size > 0) swipeStart = null;
      return;
    }
    swipeStart = null;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) showFile(dx < 0 ? next(state, count) : prev(state, count));
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);

  /** @type {Partial<Record<string, () => void>>} */
  const keys = {
    Escape: () => {
      close();
    },
    ArrowRight: () => {
      showFile(next(state, count));
    },
    ArrowLeft: () => {
      showFile(prev(state, count));
    },
    '+': () => {
      zoomStep(ZOOM_STEP);
    },
    '=': () => {
      zoomStep(ZOOM_STEP);
    },
    '-': () => {
      zoomStep(1 / ZOOM_STEP);
    },
    r: () => {
      apply(rotate(state, 1));
    },
    R: () => {
      apply(rotate(state, -1));
    },
  };
  overlay.addEventListener('keydown', (event) => {
    const act = keys[event.key];
    if (act === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    act();
  });

  function close() {
    overlay.remove();
    onClose?.();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  }

  host.appendChild(overlay);
  showFile(state);
  overlay.focus();
  return { close };
}
