import { describe, it, expect } from 'vitest';
import { base64url } from '../../src/base64url.ts';

/** The one base64url encoder (shyden-labs/shydesk#184): URL-safe letters, no padding. */

describe('base64url', () => {
  it('encodes no bytes as an empty string', () => {
    expect(base64url(new Uint8Array([]))).toBe('');
  });

  it('drops the two padding characters after one byte', () => {
    expect(base64url(new Uint8Array([0]))).toBe('AA');
  });

  it('drops the one padding character after two bytes', () => {
    expect(base64url(new Uint8Array([0, 0]))).toBe('AAA');
  });

  it('has no padding after three bytes', () => {
    expect(base64url(new Uint8Array([0, 0, 0]))).toBe('AAAA');
  });

  it('writes - and _ in place of + and /', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('encodes 32 bytes as 43 characters', () => {
    expect(base64url(new Uint8Array(32).fill(0xff))).toMatch(/^[\w-]{43}$/);
  });
});
