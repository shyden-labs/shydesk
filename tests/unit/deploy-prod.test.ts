import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutYamlComments, withoutYamlQuotes, yamlBlock as topLevel } from './source-text.ts';

/**
 * Production gets only what reaches `main`, and only through the `production`
 * environment, whose required reviewer is ShydenMcM (shyden-labs/shydesk#14 AC3).
 * Read from comment-stripped, quote-free text and compared exactly, so a widened
 * trigger or a second environment fails as surely as a missing one.
 */

const WORKFLOW = '.github/workflows/deploy-prod.yml';
const workflow = () => withoutYamlQuotes(withoutYamlComments(readFileSync(WORKFLOW, 'utf8')));
const jobs = () => topLevel(workflow(), 'jobs').split('\n');

describe('deploy-prod', () => {
  it('runs only on a push to main: no pull request, no hand start, no other branch', () => {
    expect(topLevel(workflow(), 'on')).toBe(['on:', '  push:', '    branches: [main]'].join('\n'));
  });

  it('never cancels a running production deploy', () => {
    expect(topLevel(workflow(), 'concurrency')).toBe(['concurrency:', '  group: deploy-prod', '  cancel-in-progress: false'].join('\n'));
  });

  it('asks for a read-only token', () => {
    expect(topLevel(workflow(), 'permissions')).toBe(['permissions:', '  contents: read'].join('\n'));
  });

  it('has one job, deploy-prod, which runs only for main', () => {
    expect(jobs().filter((line) => /^ {2}\S/.test(line))).toEqual(['  deploy-prod:']);
    expect(jobs()).toContain('    if: ${{ github.ref == refs/heads/main }}');
  });

  it('deploys from the production environment and no other', () => {
    expect(jobs().filter((line) => /^ {4}environment:/.test(line))).toEqual(['    environment: production']);
  });

  it('migrates and deploys the live Worker, never the dev one, refusing a missing secret', () => {
    const text = workflow();
    // `--env=""` names the top-level (live) Worker, so wrangler does not warn that no environment was chosen.
    // (The text is read with quotes removed, so `--env=""` reads as `--env=`.)
    expect(text).toContain('npx wrangler d1 migrations apply shydesk --remote --env=\n');
    expect(text).toMatch(/npx wrangler deploy --env=$/m);
    expect(text).not.toMatch(/--env\s+dev/);
    expect(text).not.toContain('--dry-run');
    expect(text).toContain('::error title=No $name in the production environment::');
  });
});
