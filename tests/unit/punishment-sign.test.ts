import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_WINDOW_SECONDS, sign, verify } from '../../src/punishments/sign.ts';

// The callback signature (shyden-labs/shydesk#60 AC1; agreed with the ShyTalk
// session): `v1=` and the hex HMAC-SHA256 of `timestamp + "." + rawBody`, keyed by
// the product's signing secret as text. A product refuses a timestamp more than
// five minutes off. `verify` ships so products and tests check with the same code.

const SECRET = 's3cret';
const TS = 1_762_500_000;
const BODY = '{"a":1}';
const independent = (secret: string, ts: number, body: string) =>
  `v1=${createHmac('sha256', secret)
    .update(`${String(ts)}.${body}`)
    .digest('hex')}`;

describe('sign', () => {
  it("matches an HMAC computed independently with node:crypto's createHmac", async () => {
    await expect(sign(SECRET, TS, BODY)).resolves.toBe(independent(SECRET, TS, BODY));
  });

  it('changes with the secret, the timestamp and the body', async () => {
    const base = await sign(SECRET, TS, BODY);
    await expect(sign('other', TS, BODY)).resolves.not.toBe(base);
    await expect(sign(SECRET, TS + 1, BODY)).resolves.not.toBe(base);
    await expect(sign(SECRET, TS, '{"a":2}')).resolves.not.toBe(base);
  });
});

describe('verify', () => {
  const header = independent(SECRET, TS, BODY);

  it('allows five minutes', () => {
    expect(SIGNATURE_WINDOW_SECONDS).toBe(300);
  });

  it('is true at now = ts + 300', async () => {
    await expect(verify(SECRET, TS, BODY, header, TS + 300)).resolves.toBe(true);
  });

  it('is true at now = ts - 300', async () => {
    await expect(verify(SECRET, TS, BODY, header, TS - 300)).resolves.toBe(true);
  });

  it('is false at now = ts + 301', async () => {
    await expect(verify(SECRET, TS, BODY, header, TS + 301)).resolves.toBe(false);
  });

  it('is false at now = ts - 301', async () => {
    await expect(verify(SECRET, TS, BODY, header, TS - 301)).resolves.toBe(false);
  });

  it('is false for a changed body, a wrong secret or another timestamp', async () => {
    await expect(verify(SECRET, TS, '{"a":2}', header, TS)).resolves.toBe(false);
    await expect(verify('other', TS, BODY, header, TS)).resolves.toBe(false);
    await expect(verify(SECRET, TS + 1, BODY, header, TS)).resolves.toBe(false);
  });

  it('is false for a header that is cut short, has no v1= or is empty', async () => {
    await expect(verify(SECRET, TS, BODY, header.slice(0, -1), TS)).resolves.toBe(false);
    await expect(verify(SECRET, TS, BODY, header.slice(3), TS)).resolves.toBe(false);
    await expect(verify(SECRET, TS, BODY, '', TS)).resolves.toBe(false);
  });
});
