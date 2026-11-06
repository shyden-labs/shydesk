import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { undeployedPaths, workerChanged, verdict, main } from '../../scripts/deploy-dev.ts';

/**
 * The dev deploy's areas (shyden-labs/shydesk#14): the Worker (src/,
 * public/, migrations/, openapi/, wrangler.jsonc) deploys; docs, tests, scripts,
 * workflows, hooks and root config never do. A change outside both fails,
 * naming the path, so new deployable code can never land without a dev deploy
 * defined for it.
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
        'vitest.integration.config.ts',
        'wdio.conf.ts',
        '.gitignore',
        '.npmrc',
        '.prettierignore',
        '.prettierrc.json',
        'LICENSE',
        'NOTICE',
      ]),
    ).toEqual([]);
  });

  it('names every path no area covers, and leaves out the Worker area', () => {
    expect(undeployedPaths(['docs/a.md', 'src/worker.ts', 'wrangler.toml', 'demo-host/index.html'])).toEqual([
      'wrangler.toml',
      'demo-host/index.html',
    ]);
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

describe('workerChanged', () => {
  it('is true for a change under src/, public/ or migrations/, or to wrangler.jsonc', () => {
    for (const path of ['src/index.ts', 'public/embed.js', 'migrations/0001_init.sql', 'wrangler.jsonc']) {
      expect(workerChanged([path]), path).toBe(true);
    }
  });

  // The API docs page serves the spec (shyden-labs/shydesk#26), so a spec change redeploys dev.
  it('is true for a change to the OpenAPI spec under openapi/', () => {
    expect(workerChanged(['openapi/shydesk.v1.yaml'])).toBe(true);
    expect(undeployedPaths(['openapi/shydesk.v1.yaml'])).toEqual([]);
  });

  // A prefix match would let `srcmap/` or `wrangler.jsonc.bak` deploy the Worker.
  it('is false for docs alone, and for names that only start like a Worker path', () => {
    expect(workerChanged(['docs/a.md', 'srcmap/a.ts', 'public-old/a.js', 'wrangler.jsonc.bak'])).toBe(false);
  });
});

describe('verdict', () => {
  it('deploys nothing and says so when nothing deployable changed', () => {
    expect(verdict(['docs/a.md'])).toEqual({
      code: 0,
      worker: false,
      lines: ['Nothing to deploy: no deployable file changed.'],
    });
  });

  it('deploys the Worker when a Worker file changed', () => {
    expect(verdict(['docs/a.md', 'src/index.ts'])).toEqual({
      code: 0,
      worker: true,
      lines: ['Deploying the Worker: a file under src/, public/, migrations/, openapi/ or wrangler.jsonc changed.'],
    });
  });

  // Even with a Worker change, an unknown path fails the whole deploy.
  it('fails naming each path no area covers, and deploys nothing', () => {
    expect(verdict(['src/a.ts', 'demo-host/a.html', 'other/b.ts'])).toEqual({
      code: 1,
      worker: false,
      lines: [
        '::error title=No dev deploy for demo-host/a.html::Define the dev deploy for this area in scripts/deploy-dev.ts before it can merge.',
        '::error title=No dev deploy for other/b.ts::Define the dev deploy for this area in scripts/deploy-dev.ts before it can merge.',
      ],
    });
  });
});

describe('main', () => {
  const folder = (): string => mkdtempSync(join(tmpdir(), 'deploy-dev-'));
  const file = (text: string): string => {
    const path = join(folder(), 'changed-files.txt');
    writeFileSync(path, text);
    return path;
  };

  it('writes worker=true to the step output when the Worker changed', () => {
    const output = join(folder(), 'output');
    expect(main([file('docs/a.md\nsrc/a.ts\n'), output])).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('worker=true\n');
  });

  // Appends, as GitHub's step output file expects, never overwrites.
  it('appends worker=false after what the output file already holds', () => {
    const output = join(folder(), 'output');
    writeFileSync(output, 'earlier=1\n');
    expect(main([file('docs/a.md\n'), output])).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('earlier=1\nworker=false\n');
  });

  it('returns 1 and writes worker=false when a path no area covers changed', () => {
    const output = join(folder(), 'output');
    expect(main([file('src/a.ts\nother/b.ts\n'), output])).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe('worker=false\n');
  });

  it('refuses a missing argument', () => {
    const usage = 'usage: node scripts/deploy-dev.ts <changed-files.txt> <step-output-file>';
    expect(() => main([])).toThrow(usage);
    expect(() => main([file('docs/a.md\n')])).toThrow(usage);
  });
});
