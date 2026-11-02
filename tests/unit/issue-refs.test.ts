import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { withoutCommentLines, withoutTsComments, withoutYamlComments } from './source-text.ts';

/**
 * A repository made from this template is a copy of every file here, so a bare
 * `#N` in a comment or a doc would read as the new repository's issue N.
 * Comments and docs cite `owner/repo#N` in full (Shyden
 * 2026-10-31, shyden-labs/repo-template#146). Strings are left alone: test
 * titles and program output that name an issue are data, and the global ruling
 * of 2026-10-30 leaves them as they are.
 */

const BARE_REF = /(?<![\w/&-])#\d+\b/g;

const IGNORED = ['node_modules/**', 'coverage/**', '.vite/**', '.git/**', '.claude/**', '.superpowers/**'];

const FILES = globSync(
  ['**/*.{ts,js,json,md}', '.github/**/*.{yml,md}', '.github/node/Dockerfile', '.githooks/*', '.gitignore', '.npmrc', '.prettierignore'],
  { exclude: IGNORED },
)
  .filter((file) => file !== 'package-lock.json')
  .sort();

/** The text of a file that is not a comment, or '' when the whole file is prose. */
function withoutComments(file: string, text: string): string {
  if (/\.(md|json)$/.test(file)) return '';
  if (/\.(ts|js)$/.test(file)) return withoutTsComments(text);
  if (file.endsWith('.yml')) return withoutYamlComments(text);
  return withoutCommentLines(text);
}

const count = (text: string): number => text.match(BARE_REF)?.length ?? 0;

describe('issue references in comments and docs', () => {
  it('reads the dot-directories a copy carries', () => {
    expect(FILES).toEqual(expect.arrayContaining(['.githooks/pre-push', '.github/workflows/ci.yml', 'README.md']));
  });

  it('cite owner/repo#N in full, never a bare #N', () => {
    const bare = FILES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return count(text) > count(withoutComments(file, text));
    });
    expect(bare).toEqual([]);
  });
});
