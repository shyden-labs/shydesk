/**
 * Every branch may deploy to dev (Shyden, 2026-11-13; shyden-labs/shydesk#136). That is safe on a public
 * repository because fork pull requests get no secrets, except on pull_request_target, which runs with them:
 * so no job that names a dev environment runs on pull_request_target.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOWS = resolve(import.meta.dirname, '../../.github/workflows');

interface Workflow {
  on?: string | string[] | Record<string, unknown>;
  jobs?: Record<string, { environment?: string | { name?: string } }>;
}

/** The events a workflow's `on` names. */
function events(on: Workflow['on']): string[] {
  if (on === undefined) return [];
  if (typeof on === 'string') return [on];
  return Array.isArray(on) ? on : Object.keys(on);
}

/** The jobs of `workflow` that name an environment with "dev" in it and run on pull_request_target. */
export function devJobsOnPullRequestTarget(workflow: Workflow): string[] {
  if (!events(workflow.on).includes('pull_request_target')) return [];
  return Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => {
      const environment = typeof job.environment === 'string' ? job.environment : job.environment?.name;
      return environment !== undefined && /dev/i.test(environment);
    })
    .map(([name]) => name);
}

describe('no dev environment on pull_request_target', () => {
  it.each(readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file)))('%s', (file) => {
    const workflow = parse(readFileSync(resolve(WORKFLOWS, file), 'utf8')) as Workflow;
    expect(devJobsOnPullRequestTarget(workflow)).toEqual([]);
  });

  it('names a job that would hand a dev secret to a fork', () => {
    expect(
      devJobsOnPullRequestTarget({
        on: { pull_request_target: {} },
        jobs: { deploy: { environment: 'dev' }, check: {}, test: { environment: { name: 'dev-ci' } }, ship: { environment: 'production' } },
      }),
    ).toEqual(['deploy', 'test']);
  });

  it('passes a dev job on pull_request, and reads `on` given as a word or a list', () => {
    expect(devJobsOnPullRequestTarget({ on: 'pull_request', jobs: { deploy: { environment: 'dev' } } })).toEqual([]);
    expect(devJobsOnPullRequestTarget({ on: ['push', 'pull_request_target'], jobs: { deploy: { environment: 'dev' } } })).toEqual([
      'deploy',
    ]);
    expect(devJobsOnPullRequestTarget({ jobs: { deploy: { environment: 'dev' } } })).toEqual([]);
  });
});
