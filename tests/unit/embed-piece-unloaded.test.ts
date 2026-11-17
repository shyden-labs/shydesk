// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The shared piece (shyden-labs/shydesk#19, shyden-labs/shydesk#25) on a page where
// what it loads from elsewhere does not come: Turnstile's script fails, and the
// viewer cannot be fetched from ShyDesk. Each is loaded once per page, so this
// file is its own page; tests/unit/embed-piece.test.ts has the rest.
const HOST = 'https://shydesk.test';

vi.mock('https://shydesk.test/embed-viewer.js', () => {
  throw new Error('the viewer could not be fetched');
});

const scripts: HTMLScriptElement[] = [];

beforeAll(async () => {
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    for (const node of nodes) {
      const script = node as HTMLScriptElement;
      scripts.push(script);
      queueMicrotask(() => script.dispatchEvent(new Event('error')));
    }
  });
  Object.defineProperty(document, 'currentScript', { configurable: true, value: { src: `${HOST}/embed.js` } });
  await import('../../public/embed.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  location.hash = '';
});

function route(answers: Record<string, () => Response>) {
  vi.stubGlobal('fetch', (url: string) => {
    const answer = answers[new URL(url).pathname.replace('/support-api/', '')];
    return answer === undefined ? Promise.reject(new TypeError('refused')) : Promise.resolve(answer());
  });
}

async function mount(view: string, until: string) {
  const piece = document.createElement('shydesk-support');
  piece.setAttribute('product', 'demo');
  piece.setAttribute('view', view);
  document.body.append(piece);
  const root = piece.shadowRoot as ShadowRoot;
  await vi.waitFor(() => {
    expect(root.querySelector('p[role="status"]')?.textContent).toBe(until);
  });
  return root;
}

describe('a page where Turnstile will not load', () => {
  it('says the form cannot load, and keeps sending impossible', async () => {
    const config = { product: { id: 'demo', name: 'Demo' }, types: [{ id: 's', name: 'S', fields: [] }], categories: [] };
    route({ config: () => Response.json({ ...config, maxAttachments: 10, maxVideoSeconds: 30, turnstileSiteKey: 'k' }) });
    const root = await mount('contact', 'The support form could not load here.');
    expect(scripts).toHaveLength(1);
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });
});

describe('a page where the viewer cannot be fetched', () => {
  it('says the viewer could not open', async () => {
    location.hash = '#t=secret';
    const thread = {
      ticket: { subject: 'S', status: 'open', createdAt: 1 },
      messages: [
        {
          author: 'customer',
          body: 'b',
          createdAt: 1,
          attachments: [{ id: 'p', mime: 'image/jpeg', bytes: 1, durationMs: null, removed: false }],
        },
      ],
    };
    route({ ticket: () => Response.json(thread), config: () => Response.json({ maxAttachments: 10, maxVideoSeconds: 30 }) });
    const root = await mount('ticket', '');
    root.querySelector<HTMLButtonElement>('button.preview')?.click();
    await vi.waitFor(() => {
      expect(root.querySelector('p[role="status"]')?.textContent).toBe('The file viewer could not open. Try again.');
    });
  });
});
