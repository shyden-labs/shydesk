import { describe, expect, it } from 'vitest';
import { fillReplyBox, openFromButton, startBadge } from '../../public/desk.js';

// The desk page's own script (shyden-labs/shydesk#24 AC4, AC5): the unread badge
// asks every 30 s only while the tab is visible, and a canned reply fills the box.
function page(visible = true) {
  const listeners: Record<string, () => void> = {};
  let timer: (() => void | Promise<void>) | null = null;
  let period = 0;
  const calls: string[] = [];
  const badge = { textContent: '' };
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (name: string, fn: () => void) => {
      listeners[name] = fn;
    },
  };
  const timers = {
    setInterval: (fn: () => void, ms: number) => {
      timer = fn;
      period = ms;
      return 1;
    },
    clearInterval: () => {
      timer = null;
    },
  };
  let answer: () => Promise<Response> = () => Promise.resolve(Response.json({ count: 3 }));
  const fetcher = (url: string) => {
    calls.push(url);
    return answer();
  };
  const start = () => startBadge(badge, doc as unknown as Document, fetcher as unknown as typeof fetch, timers);
  return {
    badge,
    doc,
    calls,
    start,
    change: () => listeners.visibilitychange?.(),
    tick: () => timer?.(),
    running: () => timer !== null,
    period: () => period,
    answerWith: (fn: () => Promise<Response>) => {
      answer = fn;
    },
  };
}

describe('startBadge', () => {
  it('asks at once and then every 30 seconds while the tab is visible', async () => {
    const p = page();
    await p.start();
    expect(p.calls).toEqual(['/desk/api/unread']);
    expect(p.badge.textContent).toBe('3');
    expect(p.period()).toBe(30_000);
    await p.tick();
    expect(p.calls).toHaveLength(2);
  });

  it('asks nothing while the tab starts hidden', async () => {
    const p = page(false);
    await p.start();
    expect(p.calls).toEqual([]);
    expect(p.running()).toBe(false);
  });

  it('stops when the tab is hidden, and asks again when it comes back', async () => {
    const p = page();
    await p.start();
    p.doc.visibilityState = 'hidden';
    p.change();
    expect(p.running()).toBe(false);
    p.doc.visibilityState = 'visible';
    p.change();
    expect(p.running()).toBe(true);
    expect(p.calls).toHaveLength(2);
  });

  it('does not start a second timer if it is already running', async () => {
    const p = page();
    await p.start();
    p.change();
    expect(p.calls).toHaveLength(1);
  });

  it('shows nothing for no unread tickets', async () => {
    const p = page();
    p.answerWith(() => Promise.resolve(Response.json({ count: 0 })));
    await p.start();
    expect(p.badge.textContent).toBe('');
  });

  it('keeps the last count when a request fails', async () => {
    const p = page();
    await p.start();
    p.answerWith(() => Promise.reject(new Error('offline')));
    await p.tick();
    expect(p.badge.textContent).toBe('3');
    p.answerWith(() => Promise.resolve(new Response('', { status: 500 })));
    await p.tick();
    expect(p.badge.textContent).toBe('3');
  });
});

describe('fillReplyBox', () => {
  it('puts the chosen reply in the box for editing, replacing what was there', () => {
    let focused = false;
    const box = {
      value: 'typed',
      focus: () => {
        focused = true;
      },
    };
    fillReplyBox({ dataset: { body: 'Hello there' } }, box);
    expect(box.value).toBe('Hello there');
    expect(focused).toBe(true);
  });

  it('empties the box for a reply with no text', () => {
    const box = { value: 'typed', focus: () => undefined };
    fillReplyBox({ dataset: {} }, box);
    expect(box.value).toBe('');
  });
});

// shyden-labs/shydesk#25: a preview opens the read-only viewer on its file,
// with every file of the ticket in page order, each read from the desk.
describe('the viewer buttons', () => {
  const photo = { dataset: { id: 'a1', mime: 'image/jpeg' } };
  const video = { dataset: { id: 'a/2', mime: 'video/mp4' } };
  const buttons = [photo, video];
  const body = { id: 'body' };
  const doc = { body };

  function viewer() {
    const opened: { doc: unknown; host: unknown; start: number; items: { mime: string; load: () => Promise<string> }[] }[] = [];
    return { opened, module: { openViewer: (options: (typeof opened)[number]) => opened.push(options) } };
  }

  it('opens the viewer on the pressed file, over the page', () => {
    const v = viewer();
    openFromButton(video, buttons, v.module, doc);
    expect(v.opened).toHaveLength(1);
    expect(v.opened[0]?.start).toBe(1);
    expect(v.opened[0]?.host).toBe(body);
    expect(v.opened[0]?.doc).toBe(doc);
  });

  it('gives it every file in page order, each read from the desk by its encoded id', async () => {
    const v = viewer();
    openFromButton(photo, buttons, v.module, doc);
    const items = v.opened[0]?.items ?? [];
    expect(items.map((item) => item.mime)).toEqual(['image/jpeg', 'video/mp4']);
    expect(await Promise.all(items.map((item) => item.load()))).toEqual(['/desk/files/a1', '/desk/files/a%2F2']);
  });
});
