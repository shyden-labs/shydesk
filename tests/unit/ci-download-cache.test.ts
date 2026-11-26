import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutPinnedShas, withoutYamlComments } from './source-text.ts';

/**
 * CI caches every download, and still takes a newer version (Shyden 2026-11-26:
 * "do the same for any other downloads we do in CI. always make sure we still
 * check for a newer version though"; shyden-labs/shydesk#305, after
 * shyden-labs/repo-template#224).
 *
 * Node is kept under a key naming its exact version, so a Dockerfile bump
 * misses and downloads the new one; npm uses setup-node's own cache. The
 * Playwright browsers are kept under the exact Playwright version npm
 * installed, so a Dependabot bump misses and downloads that version's
 * browsers. Each download step has its own time limit, so a stall fails on
 * that step, whose log names what it was fetching.
 *
 * A job holding a secret or a write permission (its own or its workflow's)
 * restores nothing from the cache: a cache key is a name, not a lock, so a
 * dependency's install script in one job could plant a binary that would then
 * run beside the token in another.
 */

const WORKFLOWS = '.github/workflows';
const FILES = ['check-release-cut.yml', 'ci.yml', 'deploy-dev.yml', 'deploy-prod.yml', 'sonarcloud.yml'];

const textOf = (file: string) => withoutYamlComments(withoutPinnedShas(readFileSync(`${WORKFLOWS}/${file}`, 'utf8')));

/** Each job of a workflow, by id, as its own text. */
const jobsOf = (text: string): Record<string, string> =>
  Object.fromEntries(
    (text.split(/^jobs:\n/m)[1] ?? '')
      .split(/^(?= {2}[\w-]+:\n)/m)
      .filter((chunk) => /^ {2}[\w-]+:\n/.test(chunk))
      .map((chunk) => [chunk.slice(2, chunk.indexOf(':')), chunk]),
  );
const jobOf = (file: string, id: string) => jobsOf(textOf(file))[id] ?? '';

/** A job's steps, each as its own text. */
const stepsOf = (job: string): string[] => job.split(/^(?= {6}- )/m).slice(1);

/** A job restores something from the cache: `actions/cache`, or a setup action's own `cache:` input. */
const restoresCache = (job: string) => job.includes('actions/cache') || /^ {10}cache: /m.test(job);

/** A job holds a secret, or a permission to write, by its own text. */
const holdsPower = (job: string) => /secrets[.:]|environment:|^ {6}[\w-]+: write$/m.test(job);

/** A workflow grants a write permission to every job at its top level. */
const workflowWrites = (text: string) => /^permissions:\n(?: {2}[\w-]+: \w+\n)*? {2}[\w-]+: write\n/m.test(text);

const jobHoldsPower = (file: string, id: string) => holdsPower(jobOf(file, id)) || workflowWrites(textOf(file));

/** The jobs that hold no secret and no write permission, and so cache their downloads. */
const CACHING_JOBS = [
  ['ci.yml', 'build-and-test'],
  ['ci.yml', 'coverage'],
  ['ci.yml', 'e2e-desktop'],
  ['ci.yml', 'e2e-playwright'],
] as const;

/** The jobs that hold a secret or a write permission, and so restore nothing. */
const TRUSTED_JOBS = [
  ['check-release-cut.yml', 'judge-release-cut'],
  ['ci.yml', 'integration'],
  ['ci.yml', 'sonarcloud'],
  ['deploy-dev.yml', 'deploy-dev'],
  ['deploy-prod.yml', 'deploy-prod'],
  ['sonarcloud.yml', 'sonarcloud'],
] as const;

/** The trusted jobs that set Node up themselves (ci.yml's sonarcloud only calls sonarcloud.yml). */
const TRUSTED_SETUPS = TRUSTED_JOBS.filter(([file, id]) => !(file === 'ci.yml' && id === 'sonarcloud'));

const NODE_CACHE = [
  '      - uses: actions/cache@<sha>',
  '        timeout-minutes: 5',
  '        with:',
  '          path: ${{ runner.tool_cache }}/node/${{ steps.node.outputs.version }}',
  '          key: node-${{ steps.node.outputs.version }}-${{ runner.os }}-${{ runner.arch }}',
].join('\n');

const PLAYWRIGHT_VERSION = [
  '      - id: playwright',
  `        run: ./node_modules/.bin/playwright --version | sed -nE 's/^Version ([0-9]+\\.[0-9]+\\.[0-9]+)$/version=\\1/p' >> "$GITHUB_OUTPUT"`,
].join('\n');

const PLAYWRIGHT_CACHE = [
  '      - uses: actions/cache@<sha>',
  '        timeout-minutes: 5',
  '        with:',
  '          path: ~/.cache/ms-playwright',
  '          key: playwright-${{ steps.playwright.outputs.version }}-${{ runner.os }}-${{ runner.arch }}',
].join('\n');

describe('every job', () => {
  it('is either a caching job or a trusted one', () => {
    const all = FILES.flatMap((file) => Object.keys(jobsOf(textOf(file))).map((id) => `${file} ${id}`));
    expect(all.sort()).toEqual([...CACHING_JOBS, ...TRUSTED_JOBS].map(([file, id]) => `${file} ${id}`).sort());
  });

  it.each(CACHING_JOBS)('%s %s holds no secret and no write permission', (file, id) => {
    expect(jobHoldsPower(file, id)).toBe(false);
  });

  it.each(TRUSTED_JOBS)('%s %s holds a secret or a write permission, and restores nothing from the cache', (file, id) => {
    expect({ power: jobHoldsPower(file, id), cache: restoresCache(jobOf(file, id)) }).toEqual({ power: true, cache: false });
  });
});

describe('restoresCache', () => {
  const job = (extra: string) =>
    ['    steps:', '      - uses: actions/setup-node@<sha>', '        with:', '          node-version: 26', extra].join('\n');

  it.each([
    ['actions/cache', '      - uses: actions/cache@<sha>', true],
    ["setup-node's npm cache", "          cache: 'npm'", true],
    ['neither', '      - run: npm run build', false],
  ])('judges a job with %s', (_, extra, restores) => {
    expect(restoresCache(job(extra))).toBe(restores);
  });
});

describe('holdsPower', () => {
  it.each([
    ['a secret', '          TOKEN: ${{ secrets.TOKEN }}', true],
    ['inherited secrets', '    secrets: inherit', true],
    ['an environment', '    environment: dev', true],
    ['a write permission', '      statuses: write', true],
    ['a read permission', '      contents: read', false],
  ])('judges a job with %s', (_, line, power) => {
    expect(holdsPower(`  job:\n${line}\n`)).toBe(power);
  });
});

describe('workflowWrites', () => {
  it.each([
    ['a top-level write grant', 'permissions:\n  contents: read\n  statuses: write\njobs:\n', true],
    ['top-level reads only', 'permissions:\n  contents: read\njobs:\n', false],
    ["only a job's own write grant", 'jobs:\n  a:\n    permissions:\n      statuses: write\n', false],
    ['no permissions at all', 'jobs:\n', false],
  ])('judges a workflow with %s', (_, text, writes) => {
    expect(workflowWrites(text)).toBe(writes);
  });
});

describe('a caching job', () => {
  it.each(CACHING_JOBS)('%s %s restores Node under its exact version just before setting it up, in 5 minutes', (file, id) => {
    const steps = stepsOf(jobOf(file, id));
    const setup = steps.findIndex((s) => s.includes('actions/setup-node@'));
    expect({ cache: steps[setup - 1]?.trimEnd(), limit: steps[setup]?.includes('        timeout-minutes: 5\n') }).toEqual({
      cache: NODE_CACHE,
      limit: true,
    });
  });

  it.each(CACHING_JOBS)("%s %s uses npm's cache and installs in 10 minutes", (file, id) => {
    const steps = stepsOf(jobOf(file, id));
    expect({
      npmCache: steps.find((s) => s.includes('actions/setup-node@'))?.includes("          cache: 'npm'\n"),
      limit: steps.find((s) => s.includes('scripts/npm-ci.ts'))?.includes('        timeout-minutes: 10\n'),
    }).toEqual({ npmCache: true, limit: true });
  });
});

describe('the Playwright job', () => {
  const steps = () => stepsOf(jobOf('ci.yml', 'e2e-playwright'));

  it('reads the installed Playwright version after npm, then restores its browsers just before installing them, in 10 minutes', () => {
    const all = steps();
    const install = all.findIndex((s) => s.includes('playwright install'));
    expect({
      afterNpm: all.findIndex((s) => s.includes('scripts/npm-ci.ts')) < install - 2,
      before: [all[install - 2]?.trimEnd(), all[install - 1]?.trimEnd()],
      limit: all[install]?.includes('        timeout-minutes: 10\n'),
    }).toEqual({ afterNpm: true, before: [PLAYWRIGHT_VERSION, PLAYWRIGHT_CACHE], limit: true });
  });
});

describe('a trusted job', () => {
  it.each(TRUSTED_SETUPS)('%s %s sets Node up in 5 minutes', (file, id) => {
    expect(stepsOf(jobOf(file, id)).find((s) => s.includes('actions/setup-node@'))).toContain('        timeout-minutes: 5\n');
  });

  it('scans in 15 minutes', () => {
    expect(stepsOf(jobOf('sonarcloud.yml', 'sonarcloud')).find((s) => s.includes('SonarSource/sonarqube-scan-action@'))).toContain(
      '        timeout-minutes: 15\n',
    );
  });
});
