/**
 * Puts the API docs into the Worker's static assets (shyden-labs/shydesk#26).
 * wrangler runs it as its build step before every deploy and dry run:
 *
 *   node scripts/build-api-docs.ts [<out-folder>]   (default: .assets)
 *
 * <out-folder>/api/docs/ gets the page and its start-up script from
 * public/api/docs/, the Swagger UI files from the pinned swagger-ui-dist
 * package (its licence and notice beside them, as Apache-2.0 asks), and the
 * spec. <out-folder>/embed.js is the shared support piece, public/embed.js.
 * Every request reaches the Worker first, which serves these only to
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
  // The shared support piece (shyden-labs/shydesk#19) sits at the assets root; the Worker serves it as /embed.js.
  copyFileSync(join(root, 'public/embed.js'), join(out, 'embed.js'));
  // Its media code, imported on the first file picked (shyden-labs/shydesk#21).
  copyFileSync(join(root, 'public/embed-media.js'), join(out, 'embed-media.js'));
  // The read-only media viewer (shyden-labs/shydesk#25), for the piece and the desk alike.
  copyFileSync(join(root, 'public/embed-viewer.js'), join(out, 'embed-viewer.js'));
  // The staff desk page's script (shyden-labs/shydesk#24).
  copyFileSync(join(root, 'public/desk.js'), join(out, 'desk.js'));
  // The video library it loads on the first video, unchanged, with what MPL-2.0 asks for.
  copyFileSync(join(root, 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'), join(out, 'embed-video.js'));
  copyFileSync(join(root, 'node_modules/mediabunny/LICENSE'), join(out, 'embed-video-LICENSE.txt'));
  copyFileSync(join(root, 'public/embed-video-NOTICE.txt'), join(out, 'embed-video-NOTICE.txt'));
}

export function main(args: string[]): number {
  if (args.length > 1) throw new Error('usage: node scripts/build-api-docs.ts [<out-folder>]');
  buildApiDocs(REPO, args[0] ?? join(REPO, '.assets'));
  return 0;
}

await runIfEntry(import.meta.url, main);
