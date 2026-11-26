// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The shared piece on a dev product page (shyden-labs/shydesk#302): ShyDesk's DEV answers only
// a DEV pass, so a piece loaded from the dev host first asks its own page's door for a
// 5-minute embed pass and sends it on every ShyDesk call. The script registers its element
// once per page, so this file is its own page, loaded from the dev host.
const DEV = 'https://shydesk.shydesk-non-prod.workers.dev';
const DOOR = `${location.origin}/__devpass/embed?for=shydesk.shydesk-non-prod.workers.dev`;
const APPEALS = `${DEV}/support-api/appeals?product=demo`;

interface Call {
  url: string;
  init: RequestInit | undefined;
}
let calls: Call[] = [];

/** Stands in the page's door and ShyDesk: `passes` in turn from the door, `answers` in turn from ShyDesk. */
function serve(passes: string[], answers: (() => Response)[]): void {
  calls = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === DOOR) return Promise.resolve(Response.json({ pass: passes.shift() }));
    const answer = answers.shift();
    return answer === undefined ? Promise.reject(new TypeError(`unplanned ${url}`)) : Promise.resolve(answer());
  });
}

const decision = (): Response => Response.json({ label: 'Ban 7 days', can_appeal: true });
const refused = (): Response => new Response(null, { status: 401 });
const header = (call: Call | undefined, name: string): string | undefined =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name];

/** The appeal view placed on the page, once its status line or decision shows. */
async function appeal(until: (piece: Element) => boolean): Promise<Element> {
  location.hash = '#appeal=token-1';
  const piece = document.createElement('shydesk-support');
  piece.setAttribute('product', 'demo');
  piece.setAttribute('view', 'appeal');
  document.body.append(piece);
  await vi.waitFor(() => {
    expect(until(piece)).toBe(true);
  });
  return piece;
}

const shows = (text: string) => (piece: Element) => piece.shadowRoot?.textContent.includes(text) === true;

beforeAll(async () => {
  Object.defineProperty(document, 'currentScript', { configurable: true, value: { src: `${DEV}/embed.js` } });
  await import('../../public/embed.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  location.hash = '';
});

describe('the piece loaded from DEV', () => {
  it("asks its own page's door for an embed pass, then sends it to ShyDesk with the call's own headers", async () => {
    serve(['pass-1'], [decision]);
    await appeal(shows('Ban 7 days'));
    expect(calls[0]?.url).toBe(DOOR);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(calls[1]?.url).toBe(APPEALS);
    expect(header(calls[1], 'X-Dev-Pass')).toBe('pass-1');
    expect(header(calls[1], 'ShyDesk-Appeal')).toBe('token-1');
  });

  // The page keeps its pass between tests, as the script loads once: here it holds pass-1.
  it('keeps the pass for the next call instead of asking again', async () => {
    serve([], [decision]);
    await appeal(shows('Ban 7 days'));
    expect(calls.map((call) => call.url)).toEqual([APPEALS]);
    expect(header(calls[0], 'X-Dev-Pass')).toBe('pass-1');
  });

  it('asks for one new pass when the door refuses the one it holds, and sends the call again with it', async () => {
    serve(['pass-3'], [refused, decision]);
    await appeal(shows('Ban 7 days'));
    expect(calls.map((call) => call.url)).toEqual([APPEALS, DOOR, APPEALS]);
    expect(calls.map((call) => header(call, 'X-Dev-Pass'))).toEqual(['pass-1', undefined, 'pass-3']);
  });

  it('says it cannot load, with no third call, when the door refuses the new pass too', async () => {
    serve(['pass-4'], [refused, refused]);
    await appeal(shows('could not load'));
    expect(calls.map((call) => call.url)).toEqual([APPEALS, DOOR, APPEALS]);
  });

  it("keeps ShyDesk's own refusal, with no new pass, when the refusal has a body", async () => {
    serve([], [() => Response.json({ error: 'no' }, { status: 401 })]);
    await appeal(shows('could not load'));
    expect(calls.map((call) => call.url)).toEqual([APPEALS]);
  });
  it('sends an empty pass, and says it cannot load, when the page has no door to give one', async () => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(url === DOOR ? new Response('not found', { status: 404 }) : refused());
    });
    await appeal(shows('could not load'));
    expect(calls.map((call) => [call.url, header(call, 'X-Dev-Pass')])).toEqual([
      [APPEALS, 'pass-4'],
      [DOOR, undefined],
      [APPEALS, ''],
    ]);
  });

  it('sends an empty pass when asking the door fails outright', async () => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url === DOOR ? Promise.reject(new TypeError('offline')) : Promise.resolve(refused());
    });
    await appeal(shows('could not load'));
    expect(header(calls.at(-1), 'X-Dev-Pass')).toBe('');
  });

  it('sends an empty pass when the door answers without one', async () => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(url === DOOR ? Response.json({}) : refused());
    });
    await appeal(shows('could not load'));
    expect(header(calls.at(-1), 'X-Dev-Pass')).toBe('');
  });
});
