import { describe, expect, it } from 'vitest';
import { verifyTurnstile, type Fetch } from '../../src/turnstile.ts';

// A new ticket needs a Turnstile result (shyden-labs/shydesk#19). The token is
// checked with Cloudflare's siteverify endpoint, sent with the client's IP;
// the hostname it answers with is returned so the caller can hold it to the
// product's own origins.
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function answering(body: unknown, status = 200) {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetcher: Fetch = (url, init) => {
    calls.push({ url, form: new URLSearchParams(init?.body as URLSearchParams) });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetcher, calls };
}

describe('verifyTurnstile', () => {
  it('sends the secret, token and client IP to siteverify', async () => {
    const { fetcher, calls } = answering({ success: true, hostname: 'shytalk.app' });
    await verifyTurnstile('sec', 'tok', '203.0.113.9', fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SITEVERIFY);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ secret: 'sec', response: 'tok', remoteip: '203.0.113.9' });
  });

  it('passes a good result with the hostname it was solved on', async () => {
    const { fetcher } = answering({ success: true, hostname: 'shytalk.app' });
    expect(await verifyTurnstile('sec', 'tok', '203.0.113.9', fetcher)).toEqual({ ok: true, hostname: 'shytalk.app', testing: false });
  });

  // Measured 2026-11-07: Cloudflare's always-pass test secret answers
  // hostname "example.com" with metadata.result_with_testing_key true. A real
  // secret refuses the dummy token, so only Non-Prod ever sees this.
  it('marks a result from a testing key', async () => {
    const { fetcher } = answering({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } });
    expect(await verifyTurnstile('sec', 'tok', '203.0.113.9', fetcher)).toEqual({ ok: true, hostname: 'example.com', testing: true });
  });

  it('names no hostname when a passed result gives none', async () => {
    const { fetcher } = answering({ success: true });
    expect(await verifyTurnstile('sec', 'tok', '203.0.113.9', fetcher)).toEqual({ ok: true, hostname: '', testing: false });
  });

  it('fails a refused result', async () => {
    const { fetcher } = answering({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await verifyTurnstile('sec', 'tok', '203.0.113.9', fetcher)).toEqual({ ok: false, hostname: '', testing: false });
  });

  it('fails when siteverify itself answers with an error status', async () => {
    const { fetcher } = answering({ success: true, hostname: 'shytalk.app' }, 500);
    expect(await verifyTurnstile('sec', 'tok', '203.0.113.9', fetcher)).toEqual({ ok: false, hostname: '', testing: false });
  });

  it('fails an empty token without asking siteverify', async () => {
    const { fetcher, calls } = answering({ success: true, hostname: 'shytalk.app' });
    expect(await verifyTurnstile('sec', '', '203.0.113.9', fetcher)).toEqual({ ok: false, hostname: '', testing: false });
    expect(calls).toHaveLength(0);
  });
});
