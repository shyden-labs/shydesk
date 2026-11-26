import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { withoutYamlComments } from './source-text.ts';

/**
 * Every CI job runs with a read-only GitHub token unless it needs more
 * (shyden-labs/shydesk#313). The repository's default workflow token can
 * write and approve pull requests, so a workflow that names no permissions
 * hands that token to every step, third-party install scripts included.
 * Each workflow therefore sets its own top-level `permissions:`.
 */

const WORKFLOWS = '.github/workflows';
const files = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();
const read = (file: string) => withoutYamlComments(readFileSync(`${WORKFLOWS}/${file}`, 'utf8'));

/** The top-level `permissions:` block of a workflow, each grant as `name: level`, or null when there is none. */
function topLevelPermissions(text: string): string[] | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  if (start < 0) return null;
  const grants: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const grant = /^ {2}([\w-]+):\s*(\w+)\s*$/.exec(line);
    if (grant === null) break;
    grants.push(`${grant[1] ?? ''}: ${grant[2] ?? ''}`);
  }
  return grants;
}

/** The `permissions:` block of one job, as for `topLevelPermissions`, or null when the job sets none. */
function jobPermissions(text: string, job: string): string[] | null {
  const body = text.split(new RegExp(`^ {2}${job}:\\n`, 'm'))[1]?.split(/^ {2}[\w-]+:\n/m)[0] ?? '';
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^ {4}permissions:\s*$/.test(line));
  if (start < 0) return null;
  const grants: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const grant = /^ {6}([\w-]+):\s*(\w+)\s*$/.exec(line);
    if (grant === null) break;
    grants.push(`${grant[1] ?? ''}: ${grant[2] ?? ''}`);
  }
  return grants;
}

describe('topLevelPermissions', () => {
  it('reads each grant of the block', () => {
    expect(topLevelPermissions('on: push\npermissions:\n  contents: read\n  statuses: write\njobs:\n')).toEqual([
      'contents: read',
      'statuses: write',
    ]);
  });

  it('is null for a workflow that names none', () => {
    expect(topLevelPermissions('on: push\njobs:\n  build:\n    permissions:\n      contents: read\n')).toBeNull();
  });
});

describe('jobPermissions', () => {
  const text =
    'jobs:\n  one:\n    runs-on: x\n  two:\n    permissions:\n      contents: read\n      pull-requests: read\n    uses: ./a.yml\n';

  it("reads one job's grants", () => {
    expect(jobPermissions(text, 'two')).toEqual(['contents: read', 'pull-requests: read']);
  });

  it('is null for a job that names none', () => {
    expect(jobPermissions(text, 'one')).toBeNull();
  });
});

describe('every workflow', () => {
  it('there is something to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s sets its own top-level permissions', (file) => {
    expect(topLevelPermissions(read(file))).not.toBeNull();
  });
});

describe('ci.yml', () => {
  it('reads the repository and nothing more', () => {
    expect(topLevelPermissions(read('ci.yml'))).toEqual(['contents: read']);
  });

  it('gives the SonarCloud call the pull-request read its workflow asks for, and nothing more', () => {
    expect(jobPermissions(read('ci.yml'), 'sonarcloud')).toEqual(['contents: read', 'pull-requests: read']);
  });
});
