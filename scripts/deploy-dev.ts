/**
 * The dev deploy's verdict on what a merge changed (shyden-labs/shydesk#14).
 *
 *   node scripts/deploy-dev.ts changed-files.txt "$GITHUB_OUTPUT"
 *
 * The Worker area (src/, public/, migrations/, openapi/, demo-host/, wrangler.jsonc)
 * deploys, the demo support page with it (shyden-labs/shydesk#19), and
 * the script appends `worker=true` to the step output for the workflow's
 * deploy step. Files that never deploy (docs, tests, scripts, workflows,
 * hooks, root config, CI's Node pin) pass. Any other path fails, named, and deploys nothing,
 * so new deployable code cannot land without a dev deploy defined for it here.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { runIfEntry } from './cli.ts';

const WORKER_FOLDERS = ['src', 'public', 'migrations', 'openapi', 'demo-host'];
const WORKER_FILES = ['wrangler.jsonc'];
const NEVER_DEPLOYED_FOLDERS = ['docs', 'tests', 'scripts', '.github', '.githooks'];
const NEVER_DEPLOYED_FILES = [
  'README.md',
  'docker/node/Dockerfile',
  'LICENSE',
  'NOTICE',
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
];

const inArea = (path: string, folders: string[], files: string[]): boolean =>
  files.includes(path) || folders.some((folder) => path.startsWith(`${folder}/`));

const listed = (paths: string[]): string[] => paths.map((path) => path.trim()).filter((path) => path !== '');

export function workerChanged(paths: string[]): boolean {
  return listed(paths).some((path) => inArea(path, WORKER_FOLDERS, WORKER_FILES));
}

export function undeployedPaths(paths: string[]): string[] {
  return listed(paths).filter(
    (path) => !inArea(path, NEVER_DEPLOYED_FOLDERS, NEVER_DEPLOYED_FILES) && !inArea(path, WORKER_FOLDERS, WORKER_FILES),
  );
}

export function verdict(paths: string[]): { code: number; worker: boolean; lines: string[] } {
  const undeployed = undeployedPaths(paths);
  if (undeployed.length > 0) {
    return {
      code: 1,
      worker: false,
      lines: undeployed.map(
        (path) =>
          `::error title=No dev deploy for ${path}::Define the dev deploy for this area in scripts/deploy-dev.ts before it can merge.`,
      ),
    };
  }
  if (workerChanged(paths)) {
    return {
      code: 0,
      worker: true,
      lines: [
        'Deploying the Worker and the demo page: a file under src/, public/, migrations/, openapi/, demo-host/ or wrangler.jsonc changed.',
      ],
    };
  }
  return { code: 0, worker: false, lines: ['Nothing to deploy: no deployable file changed.'] };
}

export function main(args: string[]): number {
  const [file, output] = args;
  if (file === undefined || output === undefined) {
    throw new Error('usage: node scripts/deploy-dev.ts <changed-files.txt> <step-output-file>');
  }
  const result = verdict(readFileSync(file, 'utf8').split('\n'));
  for (const line of result.lines) console.log(line);
  appendFileSync(output, `worker=${String(result.worker)}\n`);
  return result.code;
}

await runIfEntry(import.meta.url, main);
