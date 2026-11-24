/** Sent by shyden.co.uk's forwarder: the customer's IP, and the secret it shares with ShyDesk (shyden-labs/shyden.co.uk#1265). */
export const FORWARDED_IP_HEADER = 'ShyDesk-Client-IP';
export const FORWARDER_SECRET_HEADER = 'ShyDesk-Forwarder-Secret';

/** The forwarder secret binding, a Worker secret on each deploy behind a forwarder (never in a build). */
export interface ForwarderBindings {
  FORWARDER_SECRET?: string;
}

/**
 * The customer's IP for per-IP limits and Turnstile (shyden-labs/shydesk#273).
 * Behind the support.shyden.co.uk forwarder, CF-Connecting-IP names Cloudflare's
 * Worker egress, shared by every customer, so the forwarder sends the customer's
 * IP itself. That header is believed only when the request also carries this
 * deploy's forwarder secret; otherwise, or with no forwarded IP, CF-Connecting-IP
 * is used as before. A deploy with no secret set never believes the header.
 */
export function clientIp(headers: Headers, forwarderSecret: string | undefined): string {
  const direct = headers.get('CF-Connecting-IP') ?? '';
  const forwarded = headers.get(FORWARDED_IP_HEADER) ?? '';
  if (!forwarderSecret || forwarded === '') return direct;
  return sameSecret(headers.get(FORWARDER_SECRET_HEADER) ?? '', forwarderSecret) ? forwarded : direct;
}

/** Compares every byte, so the time taken says nothing about how much of a guess was right. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
