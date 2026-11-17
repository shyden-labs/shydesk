import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import unitConfig from '../../vitest.unit.config.ts';

/**
 * Every code file SonarCloud reads is either measured by the unit suite or left out of
 * Sonar's coverage with its reason written in docs/sonarcloud.md, so the gate never
 * reads 0% for a file nobody chose to leave unmeasured (shyden-labs/shydesk#195 AC3).
 */

const CODE = /\.(?:[cm]?js|jsx|tsx?)$/;
// Not code Sonar reads as source: dependencies, git, build and run output, and tests (sonar.tests).
const SKIPPED = new Set(['node_modules', 'coverage', 'dist', 'tests']);

function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) return [];
    const path = dir === '.' ? entry.name : join(dir, entry.name);
    if (entry.isDirectory()) return codeFiles(path);
    return CODE.test(entry.name) ? [path] : [];
  });
}

/** `public/**\/*.js` → files under `public/` ending `.js`; the unit config uses only that shape. */
function measuredBy(glob: string): (file: string) => boolean {
  const shape = /^([\w-]+)\/\*\*\/\*(\.\w+)$/.exec(glob);
  if (!shape) throw new Error(`unit coverage glob of an unknown shape: ${glob}`);
  const [, folder = '', ext = ''] = shape;
  return (file) => file.startsWith(`${folder}/`) && file.endsWith(ext);
}

const workflow = readFileSync('.github/workflows/sonarcloud.yml', 'utf8');
const exclusionsLine = /-Dsonar\.coverage\.exclusions=(\S+)/.exec(workflow);
const exclusions = exclusionsLine?.[1] ? exclusionsLine[1].split(',') : [];
const measured = unitConfig.test.coverage.include.map(measuredBy);
const doc = readFileSync('docs/sonarcloud.md', 'utf8');

describe('SonarCloud coverage scope', () => {
  it('reads the coverage exclusions from the scan', () => {
    expect(exclusions.length).toBeGreaterThan(0);
  });

  it('leaves no code file outside both the unit coverage and the coverage exclusions', () => {
    const unaccounted = codeFiles('.').filter((f) => !exclusions.includes(f) && !measured.some((m) => m(f)));
    expect(unaccounted).toEqual([]);
  });

  it('gives a reason in docs/sonarcloud.md for every coverage exclusion', () => {
    const unexplained = exclusions.filter((f) => !new RegExp(`^- \`${f.replaceAll('.', '\\.')}\`: \\S`, 'm').test(doc));
    expect(unexplained).toEqual([]);
  });
});
