// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

// How the shared piece's script starts (shyden-labs/shydesk#19): it needs to know the
// ShyDesk host it came from, and Turnstile's script must bring its API. Each is
// settled once per page, so this file is its own page.
describe('the script', () => {
  it('registers nothing when it cannot tell where it was loaded from', async () => {
    Object.defineProperty(document, 'currentScript', { configurable: true, value: null });
    await import('../../public/embed.js');
    expect(customElements.get('shydesk-support')).toBeUndefined();
  });

  it('says the form cannot load when Turnstile loads without its API', async () => {
    vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      for (const node of nodes) queueMicrotask(() => (node as Node).dispatchEvent(new Event('load')));
    });
    const config = {
      product: { id: 'demo', name: 'Demo' },
      types: [{ id: 's', name: 'S', fields: [] }],
      categories: [],
      maxAttachments: 10,
      maxVideoSeconds: 30,
      turnstileSiteKey: 'k',
    };
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(config)));
    Object.defineProperty(document, 'currentScript', { configurable: true, value: { src: 'https://shydesk.test/embed.js' } });
    vi.resetModules();
    await import('../../public/embed.js');
    const piece = document.createElement('shydesk-support');
    document.body.append(piece);
    await vi.waitFor(() => {
      expect(piece.shadowRoot?.querySelector('p[role="status"]')?.textContent).toBe('The support form could not load here.');
    });
  });
});
