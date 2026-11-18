import { describe, it, expect } from 'vitest';
import { isEmailAddress } from '../../src/email-address.ts';

/**
 * The one email-address check (shyden-labs/shydesk#184 AC1). It accepts exactly
 * what the old pattern `^[^\s@]+@[^\s@]+\.[^\s@]+$` accepted, in time linear in
 * the input: that pattern took seconds on a 50,000-character admin input.
 */

describe('isEmailAddress', () => {
  it('accepts a plain address', () => {
    expect(isEmailAddress('rep@example.com')).toBe(true);
  });

  it('accepts a domain with several dots, side by side included', () => {
    expect(isEmailAddress('a@b.c.d')).toBe(true);
    expect(isEmailAddress('a@b..c')).toBe(true);
  });

  it('refuses an address with no @', () => {
    expect(isEmailAddress('rep')).toBe(false);
  });

  it('refuses an address with two @', () => {
    expect(isEmailAddress('a@b@c.d')).toBe(false);
  });

  it('refuses an empty local part', () => {
    expect(isEmailAddress('@example.com')).toBe(false);
  });

  it('refuses a domain with no dot', () => {
    expect(isEmailAddress('a@localhost')).toBe(false);
  });

  it('refuses a domain whose only dot is first', () => {
    expect(isEmailAddress('a@.com')).toBe(false);
  });

  it('refuses a domain whose only dot is last', () => {
    expect(isEmailAddress('a@example.')).toBe(false);
  });

  it('refuses whitespace anywhere', () => {
    expect(isEmailAddress('a b@example.com')).toBe(false);
    expect(isEmailAddress('a@exam\tple.com')).toBe(false);
    expect(isEmailAddress('a@example.com\n')).toBe(false);
    expect(isEmailAddress('a@example.com ')).toBe(false);
  });

  it('answers a 50,000-character hostile address within 50 ms', () => {
    const hostile = 'a@' + '.'.repeat(50_000) + '@';
    const started = performance.now();
    expect(isEmailAddress(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
