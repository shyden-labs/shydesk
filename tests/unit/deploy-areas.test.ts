import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { undeployedPaths, verdict, main } from '../../scripts/deploy-dev.ts';

/**
 * ShyDesk has no deployable app yet (shyden-labs/shydesk#7), so dev deploys
 * nothing. A change outside the known non-deployable files fails, naming the
 * path, so app code can never land without a dev deploy defined for it.
 */

describe('undeployedPaths', () => {
  it('passes docs, tests, scripts, workflows, hooks and root config', () => {
    expect(
      undeployedPaths([
        'docs/superpowers/specs/2026-11-03-shydesk-v1-design.md',
        'tests/unit/deploy-areas.test.ts',
        'scripts/deploy-dev.ts',
        '.github/workflows/ci.yml',
        '.githooks/pre-push',
        'README.md',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'eslint.config.js',
        'vitest.unit.config.ts',
        '.gitignore',
        '.npmrc',
        '.prettierignore',
        '.prettierrc.json',
        'LICENSE',
        'NOTICE',
      ]),
    ).toEqual([]);
  });

  it('names every path that would need a deploy', () => {
    expect(undeployedPaths(['docs/a.md', 'src/worker.ts', 'wrangler.toml'])).toEqual(['src/worker.ts', 'wrangler.toml']);
  });

  // A prefix match on the folder name alone would let `docsite/` or `tests-e2e/` through.
  it('matches folders by their full name, not a prefix', () => {
    expect(undeployedPaths(['docsite/index.html', 'tests-e2e/a.ts', 'README.md.bak'])).toEqual([
      'docsite/index.html',
      'tests-e2e/a.ts',
      'README.md.bak',
    ]);
  });

  it('ignores blank lines', () => {
    expect(undeployedPaths(['', '  '])).toEqual([]);
  });
});

describe('verdict', () => {
  it('passes and says nothing was deployed when nothing deployable changed', () => {
    expect(verdict(['docs/a.md'])).toEqual({
      code: 0,
      lines: ['Nothing to deploy: ShyDesk has no deployable app yet (shyden-labs/shydesk#7), and no deployable file changed.'],
    });
  });

  it('fails naming each path when a deployable file changed', () => {
    expect(verdict(['src/a.ts', 'src/b.ts'])).toEqual({
      code: 1,
      lines: [
        '::error title=No dev deploy for src/a.ts::Define the dev deploy for this area in scripts/deploy-dev.ts before it can merge.',
        '::error title=No dev deploy for src/b.ts::Define the dev deploy for this area in scripts/deploy-dev.ts before it can merge.',
      ],
    });
  });
});

describe('main', () => {
  const file = (text: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'deploy-dev-')), 'changed-files.txt');
    writeFileSync(path, text);
    return path;
  };

  it('reads the changed-files list and returns the verdict code', () => {
    expect(main([file('docs/a.md\n')])).toBe(0);
    expect(main([file('docs/a.md\nsrc/a.ts\n')])).toBe(1);
  });

  it('refuses a missing argument', () => {
    expect(() => main([])).toThrow('usage: node scripts/deploy-dev.ts <changed-files.txt>');
  });
});
