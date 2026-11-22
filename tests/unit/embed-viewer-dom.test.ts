// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openViewer } from '../../public/embed-viewer.js';

// The read-only viewer's page work (shyden-labs/shydesk#25, shyden-labs/shydesk#108):
// what it puts on the page and how its controls, keys, wheel and pointers change it.
// The state rules themselves are tests/unit/viewer-state.test.ts's. A unit run has no
// layout or media playback, so those are stood in; the real ones are the e2e suite's.
type Item = { mime: string; load: () => Promise<string> };

const photo = (address: string): Item => ({ mime: 'image/jpeg', load: () => Promise.resolve(address) });
const video = (address: string): Item => ({ mime: 'video/mp4', load: () => Promise.resolve(address) });

/** A load that answers only when the test says. */
function heldLoad(mime: string) {
  let answer: (address: string) => void = () => undefined;
  let refuse: (reason: Error) => void = () => undefined;
  const item: Item = {
    mime,
    load: () =>
      new Promise<string>((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      }),
  };
  return {
    item,
    answer: (address: string) => {
      answer(address);
    },
    refuse: () => {
      refuse(new Error('gone'));
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(items: Item[], start = 0, onClose?: () => void) {
  const viewer = openViewer({
    doc: document,
    host: document.body,
    items,
    start,
    ...(onClose === undefined ? {} : { onClose }),
  });
  const overlay = document.querySelector<HTMLElement>('.shydesk-viewer');
  if (overlay === null) throw new Error('the viewer put nothing on the page');
  const stage = overlay.querySelector<HTMLElement>('.stage');
  if (stage === null) throw new Error('the viewer has no stage');
  const status = () => overlay.querySelector('[role="status"]')?.textContent;
  const media = () => stage.querySelector<HTMLImageElement | HTMLVideoElement>('img, video');
  const press = (label: string) => {
    const button = [...overlay.querySelectorAll('button')].find((one) => one.textContent === label);
    if (button === undefined) throw new Error(`no ${label} button`);
    button.click();
  };
  const key = (name: string) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    const stopped = vi.spyOn(event, 'stopPropagation');
    overlay.dispatchEvent(event);
    return { prevented: event.defaultPrevented, stopped: stopped.mock.calls.length > 0 };
  };
  const pointer = (type: string, pointerId: number, clientX: number, clientY: number, target: Element = stage) => {
    target.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY, bubbles: true }));
  };
  return { viewer, overlay, stage, status, media, press, key, pointer };
}

/** One finger or mouse press dragged from (x0, y0) to (x1, y1) and lifted. */
function drag(view: ReturnType<typeof open>, x0: number, y0: number, x1: number, y1: number, target?: Element) {
  view.pointer('pointerdown', 1, x0, y0, target);
  view.pointer('pointermove', 1, x1, y1, target);
  view.pointer('pointerup', 1, x1, y1, target);
}

let capture: ReturnType<typeof vi.spyOn>;
const observers: { observed: Element[]; disconnected: boolean; callback: () => void }[] = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      record: (typeof observers)[number];
      constructor(callback: () => void) {
        this.record = { observed: [], disconnected: false, callback };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.observed.push(target);
      }
      disconnect() {
        this.record.disconnected = true;
      }
    },
  );
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The viewer's constructed sheets on the page (shyden-labs/shydesk#266). */
const viewerSheets = (): CSSStyleSheet[] =>
  document.adoptedStyleSheets.filter((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes('.shydesk-viewer')));

describe('opening the viewer', () => {
  it('puts a labelled modal dialog over the page and gives it focus', () => {
    const { overlay } = open([photo('/a.jpg')]);
    expect(overlay.parentNode).toBe(document.body);
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-label')).toBe('Attachment viewer');
    expect(overlay.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(overlay);
    // A constructed sheet added to the page's own, not a <style> element (shyden-labs/shydesk#266).
    expect(overlay.querySelector('style')).toBeNull();
    expect(viewerSheets().length).toBeGreaterThan(0);
    expect(overlay.querySelector('.stage')?.getAttribute('aria-label')).toBe('Viewer stage');
    expect(overlay.querySelector('.line')?.getAttribute('aria-label')).toBe('Viewer status');
  });

  it('has every control, each a plain button, and none that changes a file', () => {
    const { overlay } = open([photo('/a.jpg')]);
    const buttons = [...overlay.querySelectorAll('button')];
    expect(buttons.map((one) => one.textContent)).toEqual([
      'Previous',
      'Next',
      'Zoom out',
      'Zoom in',
      'Rotate left',
      'Rotate right',
      'Close viewer',
    ]);
    expect(buttons.every((one) => one.getAttribute('type') === 'button')).toBe(true);
  });

  it('shows the chosen photo, named, from the address it loads', async () => {
    const { media, status } = open([photo('/a.jpg'), photo('/b.jpg')], 1);
    const img = media() as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.alt).toBe('Photo 2 full size');
    expect(img.getAttribute('aria-label')).toBe('Photo 2 full size');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(status()).toBe('Photo 2 of 2, zoom 100%, rotated 0°');
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1) rotate(0deg)');
    await flush();
    expect(img.getAttribute('src')).toBe('/b.jpg');
  });

  it('shows nothing when asked to start past the last file', () => {
    const { media, status } = open([photo('/a.jpg')], 3);
    expect(media()).toBeNull();
    expect(status()).toBe('');
  });

  it('still zooms and says so when there is no file to show', () => {
    const { press, status, media } = open([photo('/a.jpg')], 3);
    press('Zoom in');
    expect(media()).toBeNull();
    expect(status()).toBe('Photo 4 of 1, zoom 125%, rotated 0°');
  });

  it('says so when a file cannot be loaded', async () => {
    const held = heldLoad('image/jpeg');
    const { status } = open([held.item]);
    held.refuse();
    await flush();
    expect(status()).toBe('Photo 1 full size could not be loaded.');
  });

  it('ignores a load that finishes after another file is shown', async () => {
    const late = heldLoad('image/jpeg');
    const failed = heldLoad('image/jpeg');
    const { media, press, status } = open([late.item, failed.item, photo('/c.jpg')]);
    const first = media();
    press('Next');
    press('Next');
    late.answer('/late.jpg');
    failed.refuse();
    await flush();
    expect(media()?.getAttribute('src')).toBe('/c.jpg');
    expect(first?.hasAttribute('src')).toBe(false);
    expect(status()).toBe('Photo 3 of 3, zoom 100%, rotated 0°');
  });
});

describe('a video', () => {
  it('plays with the browser controls, loading only its details first', async () => {
    const { media, status } = open([video('/v.mp4')]);
    const shown = media() as HTMLVideoElement;
    expect(shown.tagName).toBe('VIDEO');
    expect(shown.hasAttribute('controls')).toBe(true);
    expect(shown.hasAttribute('playsinline')).toBe(true);
    expect(shown.getAttribute('preload')).toBe('metadata');
    expect(shown.getAttribute('aria-label')).toBe('Video 1 full size');
    expect(shown.getAttribute('draggable')).toBe('false');
    expect(status()).toBe('Video 1 of 1, zoom 100%, rotated 0°');
    await flush();
    expect(shown.getAttribute('src')).toBe('/v.mp4');
  });

  it('has a hidden drag layer over the picture, clear of the top strip and the controls bar, kept placed as it resizes', () => {
    const sizes = { offsetLeft: 10, offsetTop: 20, offsetWidth: 640, offsetHeight: 360 };
    for (const [name, value] of Object.entries(sizes)) {
      vi.spyOn(HTMLElement.prototype, name as 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
        return this instanceof HTMLVideoElement ? value : 0;
      });
    }
    const { stage, media } = open([video('/v.mp4')]);
    const over = stage.querySelector<HTMLElement>('.drag-layer');
    expect(over?.getAttribute('aria-hidden')).toBe('true');
    // shyden-labs/shydesk#108: 56 px free along the top for Safari's pills, 80 px along the bottom for Chrome's button row.
    expect([over?.style.left, over?.style.top, over?.style.width, over?.style.height]).toEqual(['10px', '76px', '640px', '224px']);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([media()]);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(30);
    observers[0]?.callback();
    expect(over?.style.height).toBe('0px');
    // At the boundary: a 137 px picture leaves 1 px of layer, a 136 px one none.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(137);
    observers[0]?.callback();
    expect(over?.style.height).toBe('1px');
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(136);
    observers[0]?.callback();
    expect(over?.style.height).toBe('0px');
  });

  it('drops the drag layer and its watcher when a photo is shown next', () => {
    const { stage, press } = open([video('/v.mp4'), photo('/a.jpg')]);
    press('Next');
    expect(stage.querySelector('.drag-layer')).toBeNull();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it('plays a paused video on a click on the drag layer, and pauses a playing one', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const paused = vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(true);
    const view = open([video('/v.mp4')]);
    const over = view.stage.querySelector('.drag-layer') as Element;
    drag(view, 100, 100, 105, 105, over);
    expect(play).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    paused.mockReturnValue(false);
    drag(view, 100, 100, 100, 100, over);
    expect(pause).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });

  it('neither plays nor pauses on a press that wanders, or one off the drag layer', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const view = open([video('/v.mp4')]);
    const over = view.stage.querySelector('.drag-layer') as Element;
    drag(view, 100, 100, 106, 108, over);
    drag(view, 100, 100, 100, 100);
    expect(play).not.toHaveBeenCalled();
  });

  it('neither plays nor pauses on a click once a photo has replaced the video', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const view = open([video('/v.mp4'), photo('/a.jpg')]);
    const over = view.stage.querySelector('.drag-layer') as Element;
    view.pointer('pointerdown', 1, 100, 100, over);
    view.press('Next');
    view.pointer('pointerup', 1, 100, 100);
    expect(play).not.toHaveBeenCalled();
  });
});

describe('the controls', () => {
  it('move to the next and previous file, round the ends, each opened fresh', () => {
    const { press, status, media } = open([photo('/a.jpg'), video('/v.mp4'), photo('/c.jpg')]);
    press('Zoom in');
    press('Next');
    expect(status()).toBe('Video 2 of 3, zoom 100%, rotated 0°');
    press('Previous');
    press('Previous');
    expect(status()).toBe('Photo 3 of 3, zoom 100%, rotated 0°');
    expect(media()?.getAttribute('alt')).toBe('Photo 3 full size');
    press('Next');
    expect(status()).toBe('Photo 1 of 3, zoom 100%, rotated 0°');
  });

  it('zoom in and out by a quarter, around the middle', () => {
    const { press, status, media } = open([photo('/a.jpg')]);
    press('Zoom in');
    expect(status()).toBe('Photo 1 of 1, zoom 125%, rotated 0°');
    expect(media()?.style.transform).toBe('translate(0px, 0px) scale(1.25) rotate(0deg)');
    press('Zoom out');
    expect(status()).toBe('Photo 1 of 1, zoom 100%, rotated 0°');
  });

  it('turn a quarter either way', () => {
    const { press, status, media } = open([photo('/a.jpg')]);
    press('Rotate right');
    expect(media()?.style.transform).toBe('translate(0px, 0px) scale(1) rotate(90deg)');
    press('Rotate left');
    press('Rotate left');
    expect(status()).toBe('Photo 1 of 1, zoom 100%, rotated 270°');
  });

  it('close the viewer, tell the opener and give focus back to what had it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const pageSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
    const before = document.adoptedStyleSheets.length;
    const { press, overlay } = open([video('/v.mp4')], 0, onClose);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    press('Close viewer');
    expect(overlay.isConnected).toBe(false);
    // Its sheet goes with it, and the page's own sheets stay (shyden-labs/shydesk#266).
    expect(document.adoptedStyleSheets).toHaveLength(before);
    expect(document.adoptedStyleSheets).toContain(pageSheet);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
    expect(observers[0]?.disconnected).toBe(true);
  });
});

describe('the keys', () => {
  it('Esc closes the viewer, with no opener to tell', () => {
    const view = open([photo('/a.jpg')]);
    expect(view.key('Escape')).toEqual({ prevented: true, stopped: true });
    expect(view.overlay.isConnected).toBe(false);
  });

  it('the arrows move between files', () => {
    const view = open([photo('/a.jpg'), photo('/b.jpg'), photo('/c.jpg')]);
    view.key('ArrowRight');
    expect(view.status()).toBe('Photo 2 of 3, zoom 100%, rotated 0°');
    view.key('ArrowLeft');
    view.key('ArrowLeft');
    expect(view.status()).toBe('Photo 3 of 3, zoom 100%, rotated 0°');
  });

  it('plus, equals and minus zoom', () => {
    const view = open([photo('/a.jpg')]);
    view.key('+');
    expect(view.status()).toBe('Photo 1 of 1, zoom 125%, rotated 0°');
    view.key('=');
    expect(view.status()).toBe('Photo 1 of 1, zoom 156%, rotated 0°');
    view.key('-');
    expect(view.status()).toBe('Photo 1 of 1, zoom 125%, rotated 0°');
  });

  it('r turns right and R turns left', () => {
    const view = open([photo('/a.jpg')]);
    view.key('r');
    expect(view.status()).toBe('Photo 1 of 1, zoom 100%, rotated 90°');
    view.key('R');
    view.key('R');
    expect(view.status()).toBe('Photo 1 of 1, zoom 100%, rotated 270°');
  });

  it('leaves every other key to the page', () => {
    const view = open([photo('/a.jpg')]);
    expect(view.key('a')).toEqual({ prevented: false, stopped: false });
    expect(view.status()).toBe('Photo 1 of 1, zoom 100%, rotated 0°');
  });
});

describe('the wheel', () => {
  it('zooms in toward the screen around the pointer, and keeps the page from scrolling', () => {
    const view = open([photo('/a.jpg')]);
    vi.spyOn(view.stage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    } as DOMRect);
    const event = new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, cancelable: true });
    // happy-dom's WheelEvent leaves out the pointer position it is given, so it is set on the event.
    Object.defineProperties(event, { clientX: { value: 300 }, clientY: { value: 150 } });
    view.stage.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.status()).toBe('Photo 1 of 1, zoom 125%, rotated 0°');
    expect(view.media()?.style.transform).toBe('translate(-25px, 0px) scale(1.25) rotate(0deg)');
  });

  it('turns a page of wheel travel into the stage height', () => {
    const view = open([photo('/a.jpg')]);
    vi.spyOn(view.stage, 'clientHeight', 'get').mockReturnValue(120);
    view.stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, deltaMode: 2, cancelable: true }));
    expect(view.status()).toBe('Photo 1 of 1, zoom 125%, rotated 0°');
  });
});

describe('pointers', () => {
  it('a sideways swipe left shows the next file and right the previous', () => {
    const view = open([photo('/a.jpg'), photo('/b.jpg'), photo('/c.jpg')]);
    drag(view, 200, 100, 150, 110);
    expect(view.status()).toBe('Photo 2 of 3, zoom 100%, rotated 0°');
    drag(view, 100, 100, 160, 90);
    expect(view.status()).toBe('Photo 1 of 3, zoom 100%, rotated 0°');
  });

  it('a short or mostly up-and-down drag changes nothing', () => {
    const view = open([photo('/a.jpg'), photo('/b.jpg')]);
    drag(view, 200, 100, 151, 100);
    drag(view, 200, 100, 140, 170);
    expect(view.status()).toBe('Photo 1 of 2, zoom 100%, rotated 0°');
  });

  it('a cancelled drag changes nothing', () => {
    const view = open([photo('/a.jpg'), photo('/b.jpg')]);
    view.pointer('pointerdown', 1, 200, 100);
    view.pointer('pointermove', 1, 100, 100);
    view.pointer('pointercancel', 1, 100, 100);
    expect(view.status()).toBe('Photo 1 of 2, zoom 100%, rotated 0°');
  });

  it('a drag on a zoomed file pans it instead of changing file', () => {
    const view = open([photo('/a.jpg'), photo('/b.jpg')]);
    view.press('Zoom in');
    drag(view, 200, 100, 120, 130);
    expect(view.status()).toBe('Photo 1 of 2, zoom 125%, rotated 0°');
    expect(view.media()?.style.transform).toBe('translate(-80px, 30px) scale(1.25) rotate(0deg)');
  });

  it('a drag on an unzoomed file never pans it', () => {
    const view = open([photo('/a.jpg')]);
    view.pointer('pointerdown', 1, 200, 100);
    view.pointer('pointermove', 1, 210, 100);
    expect(view.media()?.style.transform).toBe('translate(0px, 0px) scale(1) rotate(0deg)');
  });

  it('two fingers spreading apart zoom in around their middle, and changing file needs one finger', () => {
    const view = open([photo('/a.jpg'), photo('/b.jpg')]);
    vi.spyOn(view.stage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    } as DOMRect);
    view.pointer('pointerdown', 1, 150, 150);
    view.pointer('pointerdown', 2, 250, 150);
    view.pointer('pointermove', 2, 350, 150);
    expect(view.status()).toBe('Photo 1 of 2, zoom 200%, rotated 0°');
    view.pointer('pointerup', 2, 350, 150);
    view.pointer('pointermove', 1, 50, 150);
    view.pointer('pointerup', 1, 50, 150);
    expect(view.status()).toBe('Photo 1 of 2, zoom 200%, rotated 0°');
  });

  it('two fingers on the same spot zoom nothing', () => {
    const view = open([photo('/a.jpg')]);
    view.pointer('pointerdown', 1, 150, 150);
    view.pointer('pointerdown', 2, 150, 150);
    view.pointer('pointermove', 2, 250, 150);
    expect(view.status()).toBe('Photo 1 of 1, zoom 100%, rotated 0°');
  });

  it('captures each press to the stage, and ignores moves and lifts of a pointer it never saw', () => {
    const view = open([photo('/a.jpg'), photo('/b.jpg')]);
    view.pointer('pointerdown', 7, 200, 100);
    expect(capture).toHaveBeenCalledWith(7);
    view.pointer('pointermove', 9, 0, 0);
    view.pointer('pointerup', 9, 0, 0);
    expect(view.status()).toBe('Photo 1 of 2, zoom 100%, rotated 0°');
  });
});

describe('inside the shared piece', () => {
  it('gives focus back to the element that had it inside the shadow root', () => {
    const holder = document.createElement('div');
    document.body.append(holder);
    const root = holder.attachShadow({ mode: 'open' });
    const opener = document.createElement('button');
    root.append(opener);
    opener.focus();
    const viewer = openViewer({ doc: document, host: root, items: [photo('/a.jpg')], start: 0 });
    expect(root.querySelector('.shydesk-viewer')).not.toBeNull();
    viewer.close();
    expect(root.querySelector('.shydesk-viewer')).toBeNull();
    expect(root.activeElement).toBe(opener);
  });

  // A page sheet does not reach into a shadow root: the viewer's sheet goes on the root that holds it,
  // keeping the piece's own, and leaves with it (shyden-labs/shydesk#266; e2e on PR shyden-labs/shydesk#269 drew it off-screen).
  it("styles itself on the shadow root that holds it, keeping the piece's own sheet, and leaves the page's alone", () => {
    const holder = document.createElement('div');
    document.body.append(holder);
    const root = holder.attachShadow({ mode: 'open' });
    const pieceSheet = new CSSStyleSheet();
    root.adoptedStyleSheets = [pieceSheet];
    const pageSheets = document.adoptedStyleSheets.length;
    const viewer = openViewer({ doc: document, host: root, items: [photo('/a.jpg')], start: 0 });
    expect(root.adoptedStyleSheets).toHaveLength(2);
    expect(root.adoptedStyleSheets[0]).toBe(pieceSheet);
    expect([...(root.adoptedStyleSheets[1]?.cssRules ?? [])].map((rule) => rule.cssText).join('')).toContain('.shydesk-viewer');
    expect(document.adoptedStyleSheets).toHaveLength(pageSheets);
    viewer.close();
    expect(root.adoptedStyleSheets).toEqual([pieceSheet]);
  });

  it('gives focus to nothing when nothing in the shadow root had it', () => {
    const holder = document.createElement('div');
    document.body.append(holder);
    const root = holder.attachShadow({ mode: 'open' });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const viewer = openViewer({ doc: document, host: root, items: [photo('/a.jpg')], start: 0 });
    focus.mockClear();
    viewer.close();
    expect(focus).not.toHaveBeenCalled();
  });
});
