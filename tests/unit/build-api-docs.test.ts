import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApiDocs, main, DOCS_FILES } from '../../scripts/build-api-docs.ts';

// wrangler's build step (shyden-labs/shydesk#26) puts the API docs into the
// Worker's static assets: the page and its start-up script from
// public/api/docs/, the Swagger UI files from the pinned swagger-ui-dist
// package (with its licence and notice, as Apache-2.0 asks), and the spec.
const ROOT = new URL('../..', import.meta.url).pathname;
const out = () => mkdtempSync(join(tmpdir(), 'shydesk-docs-'));

describe('buildApiDocs', () => {
  it('writes exactly the docs files into <out>/api/docs', () => {
    const dir = out();
    buildApiDocs(ROOT, dir);
    expect(readdirSync(join(dir, 'api/docs')).sort()).toEqual(Object.keys(DOCS_FILES).sort());
  });

  it('copies each file unchanged from its source', () => {
    const dir = out();
    buildApiDocs(ROOT, dir);
    for (const [name, source] of Object.entries(DOCS_FILES)) {
      expect(readFileSync(join(dir, 'api/docs', name)).equals(readFileSync(join(ROOT, source))), name).toBe(true);
    }
  });

  it('serves the spec from the repo and Swagger UI from the installed package', () => {
    expect(DOCS_FILES['shydesk.v1.yaml']).toBe('openapi/shydesk.v1.yaml');
    expect(DOCS_FILES['swagger-ui-bundle.js']).toBe('node_modules/swagger-ui-dist/swagger-ui-bundle.js');
    expect(DOCS_FILES['swagger-ui.css']).toBe('node_modules/swagger-ui-dist/swagger-ui.css');
    expect(DOCS_FILES['swagger-ui-LICENSE.txt']).toBe('node_modules/swagger-ui-dist/LICENSE');
    expect(DOCS_FILES['swagger-ui-NOTICE.txt']).toBe('node_modules/swagger-ui-dist/NOTICE');
  });

  it('replaces what an earlier build left behind', () => {
    const dir = out();
    mkdirSync(join(dir, 'api/docs'), { recursive: true });
    writeFileSync(join(dir, 'api/docs/stale.js'), 'old');
    buildApiDocs(ROOT, dir);
    expect(readdirSync(join(dir, 'api/docs'))).not.toContain('stale.js');
  });

  it('fails naming a missing source, such as swagger-ui-dist before npm ci', () => {
    const root = out();
    expect(() => {
      buildApiDocs(root, out());
    }).toThrow(`Missing: ${Object.values(DOCS_FILES).join(', ')}. Run npm ci first.`);
  });
});

describe('the shared piece', () => {
  // shyden-labs/shydesk#19: the same build puts public/embed.js at the
  // assets root, where the Worker serves it as /embed.js.
  it('copies the media code unchanged to <out>/embed-media.js', () => {
    const dir = out();
    buildApiDocs(ROOT, dir);
    expect(readFileSync(join(dir, 'embed-media.js')).equals(readFileSync(join(ROOT, 'public/embed-media.js')))).toBe(true);
  });

  it('is copied unchanged to <out>/embed.js', () => {
    const dir = out();
    buildApiDocs(ROOT, dir);
    expect(readFileSync(join(dir, 'embed.js')).equals(readFileSync(join(ROOT, 'public/embed.js')))).toBe(true);
  });
});

describe('the docs page', () => {
  const page = readFileSync(join(ROOT, 'public/api/docs/index.html'), 'utf8');
  const start = readFileSync(join(ROOT, 'public/api/docs/init.js'), 'utf8');

  it('loads only its own files, with no inline script', () => {
    expect([...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])).toEqual(['swagger-ui.css', 'swagger-ui-bundle.js', 'init.js']);
    expect(page).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('shows the spec served beside it', () => {
    expect(start).toContain("url: 'shydesk.v1.yaml'");
  });
});

describe('main', () => {
  it('builds into the given folder and returns 0', () => {
    const dir = out();
    expect(main([dir])).toBe(0);
    expect(readdirSync(join(dir, 'api/docs'))).toContain('index.html');
  });

  // wrangler runs it with no argument; .assets is git-ignored.
  it('builds into .assets in the repo by default', () => {
    expect(main([])).toBe(0);
    expect(readdirSync(join(ROOT, '.assets/api/docs')).sort()).toEqual(Object.keys(DOCS_FILES).sort());
  });

  it('refuses more than one argument, naming the usage', () => {
    expect(() => main(['a', 'b'])).toThrow('usage: node scripts/build-api-docs.ts [<out-folder>]');
  });
});
