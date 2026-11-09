import { describe, expect, it } from 'vitest';
import { openToken, sealToken } from '../../src/tickets/seal.ts';

// A copy of each ticket's token, encrypted so a staff reply's email can carry the
// customer's unchanged private link (Shyden's ruling, shyden-labs/shydesk#24). The
// key is a Worker secret, so a copy of the database alone opens nothing.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe('sealToken and openToken', () => {
  it('gives the token back with the same key', async () => {
    expect(await openToken(KEY, await sealToken(KEY, 'the-token'))).toBe('the-token');
  });

  it('never holds the token in the clear', async () => {
    const sealed = await sealToken(KEY, 'the-token');
    expect(sealed).not.toContain('the-token');
    expect(atob(sealed)).not.toContain('the-token');
  });

  it('seals the same token differently each time', async () => {
    expect(await sealToken(KEY, 'the-token')).not.toBe(await sealToken(KEY, 'the-token'));
  });

  it('refuses another key', async () => {
    await expect(openToken(OTHER, await sealToken(KEY, 'the-token'))).rejects.toThrow();
  });

  it('refuses a sealed token that was altered', async () => {
    const bytes = Uint8Array.from(atob(await sealToken(KEY, 'the-token')), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(openToken(KEY, btoa(String.fromCharCode(...bytes)))).rejects.toThrow();
  });

  it.each([
    ['too short', btoa('short')],
    ['not base64', '!!!'],
    ['empty', ''],
  ])('refuses a key that is %s, by name', async (_name, key) => {
    await expect(sealToken(key, 'the-token')).rejects.toThrow('TICKET_TOKEN_KEY');
  });
});
