// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The desk page's wiring (shyden-labs/shydesk#24, shyden-labs/shydesk#25): on load the
// script finds the badge, the canned-reply buttons and the file previews and joins
// each to its handler. The script wires on import, so each test loads it afresh
// into its own page. The viewer it imports by URL is stood in.
const openViewer = vi.fn();
vi.mock('/embed-viewer.js', () => ({ openViewer }));

async function load(html: string, count = 4): Promise<string[]> {
  document.body.innerHTML = html;
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    return Promise.resolve(Response.json({ count }));
  });
  vi.resetModules();
  await import('../../public/desk.js');
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  openViewer.mockReset();
  document.body.innerHTML = '';
});

describe('the desk page wiring', () => {
  it('shows the unread count in the badge as the page loads', async () => {
    vi.useFakeTimers();
    const asked = await load('<span data-unread></span>');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-unread]')?.textContent).toBe('4');
    });
    expect(asked).toEqual(['/desk/api/unread']);
  });

  it('asks for no count on a page with no badge', async () => {
    const asked = await load('<p>No badge</p>');
    expect(asked).toEqual([]);
  });

  it('puts the pressed canned reply in the reply box', async () => {
    await load(
      '<textarea data-reply></textarea><button data-canned data-body="Thanks, fixed.">Fixed</button><button data-canned data-body="Looking now.">Looking</button>',
    );
    const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-canned]');
    buttons[1]?.click();
    const box = document.querySelector<HTMLTextAreaElement>('[data-reply]');
    expect(box?.value).toBe('Looking now.');
    expect(document.activeElement).toBe(box);
  });

  it('leaves canned buttons doing nothing on a page with no reply box', async () => {
    await load('<button data-canned data-body="Thanks.">Thanks</button><input value="kept">');
    document.querySelector<HTMLButtonElement>('button[data-canned]')?.click();
    expect(document.querySelector('input')?.value).toBe('kept');
  });

  it('opens the viewer on the pressed preview with every file of the page in order', async () => {
    await load(
      '<button data-view data-id="a 1" data-mime="image/jpeg">A</button><button data-view data-id="b" data-mime="video/mp4">B</button>',
    );
    document.querySelectorAll<HTMLButtonElement>('button[data-view]')[1]?.click();
    await vi.waitFor(() => {
      expect(openViewer).toHaveBeenCalledTimes(1);
    });
    const options = openViewer.mock.calls[0]?.[0] as {
      doc: unknown;
      host: unknown;
      start: number;
      items: { mime: string; load: () => Promise<string> }[];
    };
    expect(options.doc).toBe(document);
    expect(options.host).toBe(document.body);
    expect(options.start).toBe(1);
    expect(options.items.map((one) => one.mime)).toEqual(['image/jpeg', 'video/mp4']);
    expect(await Promise.all(options.items.map((one) => one.load()))).toEqual(['/desk/files/a%201', '/desk/files/b']);
  });
});
