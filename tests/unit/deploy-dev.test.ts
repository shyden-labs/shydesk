import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutYamlComments, withoutYamlQuotes, yamlBlock as topLevel } from './source-text.ts';

/**
 * A merge into `develop` deploys to dev by a workflow trigger (shyden-labs/repo-template#12; operator
 * 2026-10-14). Read from comment-stripped, quote-free text, so a comment
 * describing the trigger cannot stand in for it, and compared exactly, so a
 * widened trigger fails as surely as a missing one.
 */

const WORKFLOW = '.github/workflows/deploy-dev.yml';
const workflow = () => withoutYamlQuotes(withoutYamlComments(readFileSync(WORKFLOW, 'utf8')));

describe('deploy-dev', () => {
  it('runs on every push to develop, on every pull request as a rehearsal, and otherwise only by hand', () => {
    expect(topLevel(workflow(), 'on')).toBe(
      ['on:', '  push:', '    branches: [develop]', '  pull_request:', '  workflow_dispatch:'].join('\n'),
    );
  });

  // A newer pending run in a group cancels the older pending one, and a
  // cancelled step reads as unrun (shyden-labs/repo-template#35), so a rehearsal never shares develop's group.
  it('queues a deploy behind the running one, and rehearses each pull request in its own group', () => {
    expect(topLevel(workflow(), 'concurrency')).toBe(
      [
        'concurrency:',
        '  group: ${{ github.event_name == pull_request && format(deploy-dev-rehearsal-{0}, github.event.pull_request.number) || deploy-dev }}',
        '  cancel-in-progress: false',
      ].join('\n'),
    );
  });

  // What keeps the credential out of a pull request is dev letting only develop
  // deploy (shyden-labs/repo-template#117); this line only picks an environment a pull request may use.
  it('deploys from the dev environment, and rehearses in dev-rehearsal, which holds no credential', () => {
    const jobs = topLevel(workflow(), 'jobs').split('\n');
    expect(jobs).toContain('    environment: ${{ github.event_name == pull_request && dev-rehearsal || dev }}');
    expect(jobs.filter((line) => /^ {4}environment:/.test(line))).toHaveLength(1);
  });

  // A pull_request event has no `before`, so a rehearsal diffs against the base.
  it('lists what a pull request changes against its base', () => {
    expect(topLevel(workflow(), 'jobs').split('\n')).toContain(
      '          BEFORE: ${{ github.event.before || github.event.pull_request.base.sha }}',
    );
  });

  // The template hosts nothing, so its own develop skips the deploy (shyden-labs/repo-template#43,
  // Shyden 2026-10-27), and a repository made from it, under any other name,
  // runs it. The template's pull requests still rehearse (shyden-labs/repo-template#121, Shyden
  // 2026-10-28), so the rehearsal is proved before a project copies it. One
  // job only: the pull request rehearsal is this same job (shyden-labs/repo-template#35 AC3), so the
  // condition covers it and its steps cannot drift from the deploy.
  it('has one job, deploy-dev, skipped in the template itself except to rehearse a pull request', () => {
    const jobs = topLevel(workflow(), 'jobs').split('\n');
    expect(jobs.filter((line) => /^ {2}\S/.test(line))).toEqual(['  deploy-dev:']);
    expect(jobs.filter((line) => /^ {4}if:/.test(line))).toEqual([
      '    if: ${{ github.repository != shyden-labs/repo-template || github.event_name == pull_request }}',
    ]);
  });

  // No other job key may skip it or pass it on failure (`continue-on-error`).
  it('gives the job no key but its condition, runner, environment and steps', () => {
    const keys = topLevel(workflow(), 'jobs')
      .split('\n')
      .filter((line) => /^ {4}\S/.test(line))
      .map((line) => line.trim().split(':')[0]);
    expect(keys).toEqual(['if', 'runs-on', 'environment', 'steps']);
  });

  // ShyDesk has no deployable app yet (shyden-labs/shydesk#7): the step runs
  // scripts/deploy-dev.ts, which fails naming any file that would need a
  // deploy, and pipefail keeps tee from hiding that failure.
  it('runs the deploy verdict script on the changed files, failing when it fails', () => {
    const jobs = topLevel(workflow(), 'jobs').split('\n');
    const step = jobs.indexOf('      - name: Deploy the changed areas to dev');
    expect(jobs.slice(step).filter((line) => line.trim() !== '')).toEqual([
      '      - name: Deploy the changed areas to dev',
      '        env:',
      '          DEPLOY_REHEARSAL: ${{ github.event_name == pull_request }}',
      '        run: |',
      '          set -o pipefail',
      '          node scripts/deploy-dev.ts changed-files.txt | tee -a $GITHUB_STEP_SUMMARY',
    ]);
  });

  it('sets up the exact Node before running the script', () => {
    const jobs = topLevel(workflow(), 'jobs');
    expect(jobs).toContain('      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1');
    expect(jobs.indexOf('actions/setup-node')).toBeLessThan(jobs.indexOf('node scripts/deploy-dev.ts'));
  });
});
