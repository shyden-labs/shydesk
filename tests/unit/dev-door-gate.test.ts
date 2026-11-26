import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASS_COOKIE, PASS_HEADER, SIGNIN_ORIGIN } from '../../src/dev-door/door.ts';
import { gatedFetch, OPEN_PATHS, type GateEnv } from '../../src/dev-door/gate.ts';
import { mintPass, type PassKind, type SigningKey } from '../../src/dev-door/pass.ts';
import worker from '../../src/index.ts';
import { otherPassKeys, passKeys } from '../fixtures/dev-pass-keys.ts';

/** ShyDesk's dev Worker opens only to a DEV pass (shyden-labs/shydesk#302). */
const HOST = 'shydesk.shydesk-non-prod.workers.dev';
const NOW = 1_800_000_000;
const EMBEDS = ['https://dev.yaweloidle.com', 'https://dev.shytalk.app', 'https://dev.shyden.co.uk'];

let key: SigningKey;
let other: SigningKey;
let env: GateEnv;
const forward = vi.fn<(request: Request) => Promise<Response>>();

beforeAll(async () => {
  const pair = await passKeys();
  key = { kid: '2026-11', privateKey: pair.privateKey };
  other = { kid: '2026-11', privateKey: (await otherPassKeys()).privateKey };
  env = { DEV_PASS_HOST: HOST, DEV_PASS_KEYS: JSON.stringify({ '2026-11': pair.x }), DEV_PASS_EMBED_ORIGINS: JSON.stringify(EMBEDS) };
});

beforeEach(() => {
  forward.mockReset();
  forward.mockResolvedValue(new Response('handled', { status: 200 }));
});

const url = (path: string): string => `https://${HOST}${path}`;
const pass = (options: { kind?: PassKind; aud?: string; signer?: SigningKey; iat?: number } = {}): Promise<string> =>
  mintPass({ sub: 'rep@example.com', aud: options.aud ?? HOST, kind: options.kind ?? 'embed' }, options.signer ?? key, options.iat ?? NOW);
const gate = (request: Request, with_: GateEnv = env): Promise<Response> => gatedFetch(request, with_, forward, NOW);
const api = async (headers: Record<string, string> = {}): Promise<Response> =>
  gate(new Request(url('/support-api/config?product=demo'), { headers }));

describe('gatedFetch with no DEV door settings (live and TEST)', () => {
  it('forwards every request unchanged', async () => {
    const request = new Request(url('/support-api/config?product=demo'));
    expect((await gate(request, {})).status).toBe(200);
    expect(forward).toHaveBeenCalledWith(request);
  });
});

describe('gatedFetch on dev', () => {
  it('opens /health and exactly the public embed scripts and their licence files', () => {
    expect(OPEN_PATHS).toEqual([
      '/health',
      '/embed.js',
      '/embed-media.js',
      '/embed-viewer.js',
      '/embed-video.js',
      '/embed-video-LICENSE.txt',
      '/embed-video-NOTICE.txt',
    ]);
  });

  it.each([
    '/health',
    '/embed.js',
    '/embed-media.js',
    '/embed-viewer.js',
    '/embed-video.js',
    '/embed-video-LICENSE.txt',
    '/embed-video-NOTICE.txt',
  ])('forwards %s with no pass', async (path) => {
    expect((await gate(new Request(url(path)))).status).toBe(200);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('refuses a path that only starts like an open one', async () => {
    expect((await gate(new Request(url('/embed.js.map')))).status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses an API call with no pass, before any handler runs', async () => {
    expect((await api()).status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses a pass signed by a key the door does not list', async () => {
    expect((await api({ [PASS_HEADER]: await pass({ signer: other }) })).status).toBe(401);
  });

  it('refuses a pass whose kid the door does not list', async () => {
    expect((await api({ [PASS_HEADER]: await pass({ signer: { ...key, kid: '2025-01' } }) })).status).toBe(401);
  });

  it('refuses a pass for another host', async () => {
    expect((await api({ [PASS_HEADER]: await pass({ aud: 'dev.shytalk.app' }) })).status).toBe(401);
  });

  it('refuses an expired embed pass', async () => {
    expect((await api({ [PASS_HEADER]: await pass({ iat: NOW - 301 }) })).status).toBe(401);
  });

  it.each(['embed', 'browser', 'machine'] as const)('forwards a valid %s pass', async (kind) => {
    expect((await api({ [PASS_HEADER]: await pass({ kind }) })).status).toBe(200);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('sends a page request with no pass to the sign-in, to come back to the same page', async () => {
    const response = await gate(new Request(url('/desk?product=demo'), { headers: { accept: 'text/html' } }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${SIGNIN_ORIGIN}/pass?for=${HOST}&back=%2Fdesk%3Fproduct%3Ddemo`);
  });

  // Review Focus 1: the Access cookie still reaches the desk; only the pass is taken off.
  it('keeps the Access cookie and strips only the pass cookie', async () => {
    const cookie = `CF_Authorization=access-token; ${PASS_COOKIE}=${await pass({ kind: 'browser' })}`;
    await gate(new Request(url('/desk'), { headers: { cookie } }));
    const forwarded = forward.mock.calls[0]?.[0];
    expect(forwarded?.headers.get('cookie')).toBe('CF_Authorization=access-token');
  });

  it.each(EMBEDS)('answers a preflight from %s, allowing X-Dev-Pass', async (origin) => {
    const response = await gate(
      new Request(url('/support-api/tickets'), {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-dev-pass, content-type' },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-headers')).toBe('X-Dev-Pass, Content-Type');
  });

  it('refuses a preflight from any other origin', async () => {
    const response = await gate(
      new Request(url('/support-api/tickets'), {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      }),
    );
    expect(response.status).toBe(403);
  });

  // Review Focus 2: the door lets the call in; ShyDesk's own per-product origin check still answers.
  it("passes an embed origin's call on to ShyDesk's own handlers, which keep their own answer", async () => {
    forward.mockResolvedValue(new Response('origin not allowed', { status: 403 }));
    const response = await gate(
      new Request(url('/support-api/tickets'), { method: 'POST', headers: { origin: EMBEDS[0] ?? '', [PASS_HEADER]: await pass() } }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('origin not allowed');
    expect(response.headers.get('access-control-allow-origin')).toBe(EMBEDS[0]);
  });

  // Review Focus 5: a broken setting never opens the gate.
  it.each([
    ['DEV_PASS_KEYS', { DEV_PASS_KEYS: '{not json' }],
    ['DEV_PASS_KEYS', { DEV_PASS_KEYS: undefined }],
    ['DEV_PASS_KEYS', { DEV_PASS_KEYS: '["a"]' }],
    ['DEV_PASS_EMBED_ORIGINS', { DEV_PASS_EMBED_ORIGINS: '{not json' }],
    ['DEV_PASS_EMBED_ORIGINS', { DEV_PASS_EMBED_ORIGINS: '{"a":1}' }],
  ] as const)('refuses everything gated with 500 naming %s when it is missing or malformed', async (name, broken) => {
    const response = await gate(new Request(url('/support-api/config')), { ...env, ...broken } as GateEnv);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(`The DEV door's ${name} setting is missing or malformed.`);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("the Worker's fetch", () => {
  it('refuses an API call with no pass when dev sets the door', async () => {
    const response = await worker.fetch(new Request(url('/support-api/config?product=demo')), env);
    expect(response.status).toBe(401);
  });

  it('answers /health with no pass when dev sets the door', async () => {
    const response = await worker.fetch(new Request(url('/health')), env);
    expect(await response.json()).toEqual({ ok: true });
  });
});
