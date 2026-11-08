/**
 * Checks a Turnstile token with Cloudflare's siteverify endpoint
 * (shyden-labs/shydesk#19), sending the client's IP. Returns whether it
 * passed, the hostname it was solved on (for the caller to hold to the
 * product's origins) and whether a testing key answered: Cloudflare's test
 * secrets name "example.com" and set `metadata.result_with_testing_key`
 * (measured 2026-11-07), and a real secret refuses their dummy token.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TurnstileResult {
  ok: boolean;
  hostname: string;
  testing: boolean;
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const FAILED: TurnstileResult = { ok: false, hostname: '', testing: false };

interface Siteverify {
  success?: boolean;
  hostname?: string;
  metadata?: { result_with_testing_key?: boolean };
}

export async function verifyTurnstile(secret: string, token: string, ip: string, fetcher: Fetch = fetch): Promise<TurnstileResult> {
  if (token === '') return FAILED;
  const response = await fetcher(SITEVERIFY, {
    method: 'POST',
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
  });
  if (!response.ok) return FAILED;
  const body = (await response.json()) as Siteverify;
  if (body.success !== true) return FAILED;
  return { ok: true, hostname: body.hostname ?? '', testing: body.metadata?.result_with_testing_key === true };
}
