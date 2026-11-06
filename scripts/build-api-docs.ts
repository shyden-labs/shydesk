/**
 * Puts the API docs into the Worker's static assets (shyden-labs/shydesk#26).
 * wrangler runs it as its build step before every deploy and dry run:
 *
 *   node scripts/build-api-docs.ts [<out-folder>]   (default: .assets)
 *
 * <out-folder>/api/docs/ gets the page and its start-up script from
 * public/api/docs/, the Swagger UI files from the pinned swagger-ui-dist
 * package (its licence and notice beside them, as Apache-2.0 asks), and the
 * spec. Every request reaches the Worker first, which serves these only to
 * staff (src/api/docs.ts).
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runIfEntry } from './cli.ts';

/** Each file served under /api/docs/, and the repo path it is copied from. */
export const DOCS_FILES: Record<string, string> = {
  'index.html': 'public/api/docs/index.html',
  'init.js': 'public/api/docs/init.js',
  'shydesk.v1.yaml': 'openapi/shydesk.v1.yaml',
  'swagger-ui-bundle.js': 'node_modules/swagger-ui-dist/swagger-ui-bundle.js',
  'swagger-ui.css': 'node_modules/swagger-ui-dist/swagger-ui.css',
  'swagger-ui-LICENSE.txt': 'node_modules/swagger-ui-dist/LICENSE',
  'swagger-ui-NOTICE.txt': 'node_modules/swagger-ui-dist/NOTICE',
};

const REPO = new URL('..', import.meta.url).pathname;

export function buildApiDocs(root: string, out: string): void {
  const missing = Object.values(DOCS_FILES).filter((source) => !existsSync(join(root, source)));
  if (missing.length > 0) throw new Error(`Missing: ${missing.join(', ')}. Run npm ci first.`);
  const docs = join(out, 'api/docs');
  rmSync(docs, { recursive: true, force: true });
  mkdirSync(docs, { recursive: true });
  for (const [name, source] of Object.entries(DOCS_FILES)) copyFileSync(join(root, source), join(docs, name));
}

export function main(args: string[]): number {
  if (args.length > 1) throw new Error('usage: node scripts/build-api-docs.ts [<out-folder>]');
  buildApiDocs(REPO, args[0] ?? join(REPO, '.assets'));
  return 0;
}

await runIfEntry(import.meta.url, main);
