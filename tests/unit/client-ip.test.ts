import { describe, expect, it } from 'vitest';
import { clientIp } from '../../src/client-ip.ts';

// Live ShyDesk is served at support.shyden.co.uk through a forwarding Worker
// in shyden.co.uk's Cloudflare account (shyden-labs/shydesk#273). Behind it,
// CF-Connecting-IP names Cloudflare's Worker egress, so every customer would
// share one per-IP limit. The forwarder sends the customer's IP in
// ShyDesk-Client-IP with a shared secret in ShyDesk-Forwarder-Secret; ShyDesk
// believes that header only when the secret matches its own.
const SECRET = 'forwarder-secret-0123456789abcdef';
const EGRESS = '2a06:98c0:3600::103';
const CUSTOMER = '203.0.113.44';

const headers = (fields: Record<string, string>) => new Headers(fields);

describe('clientIp', () => {
  it('takes the forwarded customer IP when the forwarder secret matches', () => {
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Client-IP': CUSTOMER, 'ShyDesk-Forwarder-Secret': SECRET });
    expect(clientIp(request, SECRET)).toBe(CUSTOMER);
  });

  it('keeps CF-Connecting-IP when the forwarder secret is wrong', () => {
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Client-IP': CUSTOMER, 'ShyDesk-Forwarder-Secret': `${SECRET}x` });
    expect(clientIp(request, SECRET)).toBe(EGRESS);
  });

  it('keeps CF-Connecting-IP when a wrong secret has the same length', () => {
    const wrong = `${SECRET.slice(0, -1)}0`;
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Client-IP': CUSTOMER, 'ShyDesk-Forwarder-Secret': wrong });
    expect(clientIp(request, SECRET)).toBe(EGRESS);
  });

  it('keeps CF-Connecting-IP when the request sends only the start of the secret', () => {
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Client-IP': CUSTOMER, 'ShyDesk-Forwarder-Secret': SECRET.slice(0, 8) });
    expect(clientIp(request, SECRET)).toBe(EGRESS);
  });

  it('keeps CF-Connecting-IP when the request carries no forwarder secret', () => {
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Client-IP': CUSTOMER });
    expect(clientIp(request, SECRET)).toBe(EGRESS);
  });

  it('keeps CF-Connecting-IP when this deploy holds no forwarder secret, whatever the request claims', () => {
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Client-IP': CUSTOMER, 'ShyDesk-Forwarder-Secret': '' });
    expect(clientIp(request, undefined)).toBe(EGRESS);
    expect(clientIp(request, '')).toBe(EGRESS);
  });

  it('keeps CF-Connecting-IP when the secret matches but the forwarded IP header is missing', () => {
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Forwarder-Secret': SECRET });
    expect(clientIp(request, SECRET)).toBe(EGRESS);
  });

  it('keeps CF-Connecting-IP when the secret matches but the forwarded IP header is empty', () => {
    const request = headers({ 'CF-Connecting-IP': EGRESS, 'ShyDesk-Client-IP': '', 'ShyDesk-Forwarder-Secret': SECRET });
    expect(clientIp(request, SECRET)).toBe(EGRESS);
  });

  it('answers an empty string when the request carries no IP at all, as before', () => {
    expect(clientIp(headers({}), SECRET)).toBe('');
  });
});
