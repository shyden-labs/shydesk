import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// A product styles the piece only through the properties docs/embedding.md lists, so every one
// the piece reads is listed there, and nothing listed is unread (shyden-labs/shydesk#282 AC3).
describe('the theme properties', () => {
  it('are each listed in the embedding guide, and the guide lists no other', () => {
    const read_ = [...read('public/embed.js').matchAll(/var\((--shydesk-[a-z-]+)/g)].map(([, name]) => name);
    const listed = [...read('docs/embedding.md').matchAll(/^\| `(--shydesk-[a-z-]+)`/gm)].map(([, name]) => name);
    expect([...new Set(listed)].sort()).toEqual([...new Set(read_)].sort());
  });
});
