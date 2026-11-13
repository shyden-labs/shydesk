/// <reference lib="dom" />
/**
 * The staff desk page's script (shyden-labs/shydesk#24): the unread badge, which
 * asks every 30 s only while the tab is visible, and the canned-reply buttons.
 * A plain module, typed with JSDoc and checked by `tsc`, so it ships as written.
 */

const EVERY_MS = 30_000;
const VIEWER = '/embed-viewer.js';

/**
 * @param {{ textContent: string | null }} badge
 * @param {Document} doc
 * @param {typeof fetch} fetcher
 * @param {{ setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (id: never) => void }} timers
 */
export async function startBadge(badge, doc, fetcher, timers) {
  /** @type {unknown} */
  let running = null;
  const ask = async () => {
    try {
      const answer = await fetcher('/desk/api/unread');
      if (!answer.ok) return;
      const raw = /** @type {unknown} */ (await answer.json());
      const { count } = /** @type {{ count: number }} */ (raw);
      badge.textContent = count === 0 ? '' : String(count);
    } catch {
      // The next tick asks again; the last count stays until then.
    }
  };
  const start = async () => {
    if (running !== null || doc.visibilityState !== 'visible') return;
    running = timers.setInterval(() => void ask(), EVERY_MS);
    await ask();
  };
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') {
      void start();
    } else if (running !== null) {
      timers.clearInterval(/** @type {never} */ (running));
      running = null;
    }
  });
  await start();
}

/**
 * Puts the chosen canned reply in the box, for the rep to edit before sending.
 * @param {{ dataset: Record<string, string | undefined> }} button
 * @param {{ value: string, focus: () => void }} box
 */
export function fillReplyBox(button, box) {
  box.value = button.dataset.body ?? '';
  box.focus();
}

/**
 * Opens the read-only viewer (shyden-labs/shydesk#25) on the pressed preview's
 * file, with every file of the ticket in page order, each read from the desk.
 * @param {{ dataset: Record<string, string | undefined> }} button
 * @param {{ dataset: Record<string, string | undefined> }[]} buttons
 * @param {{ openViewer: (options: { doc: never, host: never, start: number, items: { mime: string, load: () => Promise<string> }[] }) => unknown }} viewer
 * @param {{ body: unknown }} doc
 */
export function openFromButton(button, buttons, viewer, doc) {
  viewer.openViewer({
    doc: /** @type {never} */ (doc),
    host: /** @type {never} */ (doc.body),
    start: buttons.indexOf(button),
    items: buttons.map((one) => ({
      mime: one.dataset.mime ?? '',
      load: () => Promise.resolve(`/desk/files/${encodeURIComponent(one.dataset.id ?? '')}`),
    })),
  });
}

/**
 * The page's own timers for startBadge. Each calls the global itself: handed over as a method,
 * a browser's clearInterval gets the timers object as `this` and refuses it (shyden-labs/shydesk#139).
 */
export const pageTimers = {
  setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setInterval(fn, ms),
  clearInterval: (/** @type {never} */ id) => {
    clearInterval(id);
  },
};

if (typeof document !== 'undefined') {
  const badge = document.querySelector('[data-unread]');
  if (badge !== null) void startBadge(badge, document, fetch.bind(globalThis), pageTimers);
  const box = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('[data-reply]'));
  if (box !== null) {
    for (const button of document.querySelectorAll('button[data-canned]')) {
      button.addEventListener('click', () => {
        fillReplyBox(/** @type {HTMLButtonElement} */ (button), box);
      });
    }
  }
  const previews = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('button[data-view]')]);
  for (const button of previews) {
    button.addEventListener('click', () => {
      // The same file the piece imports, fetched by the browser from this origin when first needed. Nothing
      // bundles this script (it ships as written), so the unit runner is told not to follow the path.
      void (
        /** @type {Promise<unknown>} */ (import(/* @vite-ignore */ VIEWER)).then((viewer) => {
          openFromButton(button, previews, /** @type {never} */ (viewer), document);
        })
      );
    });
  }
}
