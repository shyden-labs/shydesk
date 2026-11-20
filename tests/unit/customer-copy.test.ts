import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../src/customer/messages.ts';

// Shyden Labs is one person to the public and never said to be alone
// (global rule, 2026-11-02): nothing a customer reads says we, us, our, I,
// me, my, the team or solo (shyden-labs/shydesk#19 AC4). This reads every
// string literal in the shared piece and every message the customer API sends.
const BANNED = /\b(we|us|our|ours|i|me|my|mine|team|solo)\b/i;
const PIECE = readFileSync(new URL('../../public/embed.js', import.meta.url), 'utf8');

/** Every '...', "..." and `...` literal in the source, comments left out. */
function literals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

describe('customer copy', () => {
  it('finds the strings the piece shows', () => {
    expect(literals(PIECE)).toContain('Send');
    expect(literals("const a = 'one';\n// 'skipped'\nconst b = `two`;")).toEqual(['one', 'two']);
  });

  it('catches a banned word', () => {
    expect(BANNED.test('Our team will reply')).toBe(true);
    expect(BANNED.test('Reply from support')).toBe(false);
  });

  it.each(literals(PIECE).filter((s) => /[a-z] [a-z]/i.test(s)))('piece text "%s" has no banned word', (text) => {
    expect(text).not.toMatch(BANNED);
  });

  it.each(Object.entries(MESSAGES))('API message %s has no banned word', (_name, text) => {
    expect(text).not.toMatch(BANNED);
  });
});
