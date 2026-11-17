/**
 * The punishment callback's signature (shyden-labs/shydesk#60; agreed with the
 * ShyTalk session): `v1=` and the lowercase hex HMAC-SHA256 of
 * `timestamp + "." + rawBody`, keyed by the product's signing secret as UTF-8
 * text. `timestamp` is Unix seconds, sent as `ShyDesk-Timestamp`. A product refuses
 * a timestamp more than five minutes off. `verify` ships so products and tests
 * check with the same code.
 */

export const SIGNATURE_WINDOW_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `ShyDesk-Signature` header for this timestamp and body. */
export async function sign(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const signed = `${String(timestamp)}.${rawBody}`;
  return `v1=${await hmacHex(secret, signed)}`;
}

/** Compares two strings in time that depends only on their length. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** True when `header` signs this timestamp and body, and the timestamp is within five minutes of `now` (Unix seconds). */
export async function verify(secret: string, timestamp: number, rawBody: string, header: string, now: number): Promise<boolean> {
  if (Math.abs(now - timestamp) > SIGNATURE_WINDOW_SECONDS) return false;
  return sameText(header, await sign(secret, timestamp, rawBody));
}
