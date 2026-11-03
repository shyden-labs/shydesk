/**
 * The dev deploy's verdict on what a merge changed (shyden-labs/shydesk#7).
 *
 *   node scripts/deploy-dev.ts changed-files.txt
 *
 * ShyDesk has no deployable app yet, so dev deploys nothing. Files that never
 * deploy (docs, tests, scripts, workflows, hooks, root config) pass; any other
 * path fails, named, so app code cannot land without a dev deploy defined for
 * it here. The Worker deploy replaces this when Release 1's foundations land.
 */
import { readFileSync } from 'node:fs';
import { runIfEntry } from './cli.ts';

const NEVER_DEPLOYED_FOLDERS = ['docs', 'tests', 'scripts', '.github', '.githooks'];
const NEVER_DEPLOYED_FILES = [
  'README.md',
  'LICENSE',
  'NOTICE',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'eslint.config.js',
  'vitest.unit.config.ts',
  '.gitignore',
  '.npmrc',
  '.prettierignore',
  '.prettierrc.json',
];

export function undeployedPaths(paths: string[]): string[] {
  return paths
    .map((path) => path.trim())
    .filter((path) => path !== '')
    .filter((path) => !NEVER_DEPLOYED_FILES.includes(path))
    .filter((path) => !NEVER_DEPLOYED_FOLDERS.some((folder) => path.startsWith(`${folder}/`)));
}

export function verdict(paths: string[]): { code: number; lines: string[] } {
  const undeployed = undeployedPaths(paths);
  if (undeployed.length === 0) {
    return {
      code: 0,
      lines: ['Nothing to deploy: ShyDesk has no deployable app yet (shyden-labs/shydesk#7), and no deployable file changed.'],
    };
  }
  return {
    code: 1,
    lines: undeployed.map(
      (path) =>
        `::error title=No dev deploy for ${path}::Define the dev deploy for this area in scripts/deploy-dev.ts before it can merge.`,
    ),
  };
}

export function main(args: string[]): number {
  const [file] = args;
  if (file === undefined) throw new Error('usage: node scripts/deploy-dev.ts <changed-files.txt>');
  const result = verdict(readFileSync(file, 'utf8').split('\n'));
  for (const line of result.lines) console.log(line);
  return result.code;
}

await runIfEntry(import.meta.url, main);
