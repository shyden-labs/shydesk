/**
 * One suite, every target, the same total (shyden-labs/shydesk#42 AC2).
 *
 * Each spec file's worker writes a run file with its target and counts into one
 * folder; this adds each target's files together, prints every target's total
 * on one line, and fails naming any target that ran fewer tests than another
 * or than the whole suite, skipped one or ran none. The suite's count is read
 * from the spec files, so targets run separately (the browsers in CI, the
 * phones on this Mac) are each held to the same total
 * (shyden-labs/shydesk#172).
 *
 *   node scripts/e2e-totals.ts <folder of run files> <folder of spec files>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { runIfEntry } from './cli.ts';

export interface TargetRun {
  target: string;
  passed: number;
  failed: number;
  skipped: number;
}

const total = (run: TargetRun): number => run.passed + run.failed + run.skipped;
const tests = (count: number): string => `${String(count)} test${count === 1 ? '' : 's'}`;

/** The device groups: within each, every target runs the identical set (shyden-labs/shydesk#175). */
export type Group = 'phone' | 'desktop';
export type GroupCounts = Record<Group, number>;

const GROUPS: Record<Group, readonly string[]> = { phone: ['android', 'ios'], desktop: ['chromium', 'firefox', 'safari'] };

/** The group a target belongs to, or a throw naming a target in none. */
export function groupOf(target: string): Group {
  const group = (Object.keys(GROUPS) as Group[]).find((name) => GROUPS[name].includes(target));
  if (group === undefined) {
    throw new Error(`${target} is in no device group (phone: ${GROUPS.phone.join(', ')}; desktop: ${GROUPS.desktop.join(', ')})`);
  }
  return group;
}

/** Every way these runs fall short of their group's set, run unchanged on every target in it. */
export function totalsProblems(runs: readonly TargetRun[], counts: GroupCounts): string[] {
  if (runs.length === 0) return ['no target reported a run'];
  return [...runs]
    .sort((a, b) => a.target.localeCompare(b.target))
    .flatMap((run) => {
      const group = groupOf(run.target);
      const suite = counts[group];
      const most = Math.max(...runs.filter((other) => groupOf(other.target) === group).map(total));
      const problems: string[] = [];
      if (total(run) === 0) problems.push(`${run.target} ran no tests`);
      else if (total(run) < suite) problems.push(`${run.target} ran ${tests(total(run))}; the ${group} group has ${String(suite)}`);
      else if (total(run) > suite)
        problems.push(`${run.target} ran ${tests(total(run))}; the ${group} group was counted at ${String(suite)}`);
      else if (total(run) < most) problems.push(`${run.target} ran ${tests(total(run))}; another target ran ${String(most)}`);
      if (run.skipped > 0) problems.push(`${run.target} skipped ${tests(run.skipped)}`);
      return problems;
    });
}

/** A spec file: its name and its text. */
export interface SpecFile {
  name: string;
  text: string;
}

/**
 * How many tests the spec files hold: one per `it(` at the start of a line.
 * A form whose count needs running the file (`it.each`) is refused by name.
 */
export function suiteCount(files: readonly SpecFile[]): number {
  return files.reduce((sum, file) => {
    if (/^[ \t]*it\.each\b/m.test(file.text)) {
      throw new Error(`${file.name}: it.each cannot be counted by reading the file; write one it() per case`);
    }
    return sum + (file.text.match(/^[ \t]*it\(/gm) ?? []).length;
  }, 0);
}

/** One run per target, its spec-file runs added together, in target order. */
export function byTarget(runs: readonly TargetRun[]): TargetRun[] {
  const sums = new Map<string, TargetRun>();
  for (const run of runs) {
    const sum = sums.get(run.target) ?? { target: run.target, passed: 0, failed: 0, skipped: 0 };
    sums.set(run.target, {
      target: run.target,
      passed: sum.passed + run.passed,
      failed: sum.failed + run.failed,
      skipped: sum.skipped + run.skipped,
    });
  }
  return [...sums.values()].sort((a, b) => a.target.localeCompare(b.target));
}

/** Each target and its total, in target order: `android 10 · chromium 10`. */
export function formatTotals(runs: readonly TargetRun[]): string {
  return [...runs]
    .sort((a, b) => a.target.localeCompare(b.target))
    .map((run) => `${run.target} ${String(total(run))}`)
    .join(' · ');
}

function isRun(value: unknown): value is TargetRun {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Record<string, unknown>;
  const count = (key: string): boolean => Number.isInteger(run[key]) && (run[key] as number) >= 0;
  return typeof run.target === 'string' && run.target !== '' && count('passed') && count('failed') && count('skipped');
}

/** Every `.json` run file in `folder`, or a throw naming one that is not a run. */
export function readRuns(folder: string): TargetRun[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = `${folder}/${name}`;
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRun(value)) throw new Error(`${path} is not a run: {target, passed, failed, skipped}`);
      return value;
    });
}

/**
 * Each group's test count: shared files count in both groups; a file named
 * `<name>.phone.e2e.ts` or `<name>.desktop.e2e.ts` counts in its group only and
 * must open with `// <group>-only: <the input or feature that differs>`.
 */
export function groupCounts(files: readonly SpecFile[]): GroupCounts {
  const counts: GroupCounts = { phone: 0, desktop: 0 };
  for (const file of files) {
    const tag = /\.([a-z]+)\.e2e\.ts$/.exec(file.name)?.[1];
    const tests = suiteCount([file]);
    if (tag === undefined) {
      counts.phone += tests;
      counts.desktop += tests;
      continue;
    }
    if (tag !== 'phone' && tag !== 'desktop') {
      throw new Error(`${file.name}: "${tag}" is not a device group; a test runs everywhere, or is tagged phone or desktop`);
    }
    const reason = new RegExp(`^// ${tag}-only: \\S`).test(file.text);
    if (!reason) {
      throw new Error(
        `${file.name} runs on ${tag} only but gives no reason: its first line must be "// ${tag}-only: <the input or feature that differs>"`,
      );
    }
    counts[tag] += tests;
  }
  return counts;
}

export function main(args: string[]): number {
  const [folder, specs, ...rest] = args;
  if (folder === undefined || specs === undefined || rest.length > 0) {
    throw new Error('usage: node scripts/e2e-totals.ts <folder of run files> <folder of spec files>');
  }
  const counts = groupCounts(
    readdirSync(specs)
      .filter((name) => name.endsWith('.e2e.ts'))
      .map((name) => ({ name, text: readFileSync(`${specs}/${name}`, 'utf8') })),
  );
  const runs = byTarget(readRuns(folder));
  process.stdout.write(`e2e-totals: ${formatTotals(runs)} (phone ${String(counts.phone)} · desktop ${String(counts.desktop)})\n`);
  const problems = totalsProblems(runs, counts);
  for (const problem of problems) process.stderr.write(`e2e-totals: ${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

await runIfEntry(import.meta.url, main);
