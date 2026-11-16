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

/** Every way these runs fall short of the whole suite, `suite` tests, run unchanged on every target. */
export function totalsProblems(runs: readonly TargetRun[], suite: number): string[] {
  if (runs.length === 0) return ['no target reported a run'];
  const most = Math.max(...runs.map(total));
  return [...runs]
    .sort((a, b) => a.target.localeCompare(b.target))
    .flatMap((run) => {
      const problems: string[] = [];
      if (total(run) === 0) problems.push(`${run.target} ran no tests`);
      else if (total(run) < suite) problems.push(`${run.target} ran ${tests(total(run))}; the suite has ${String(suite)}`);
      else if (total(run) > suite) problems.push(`${run.target} ran ${tests(total(run))}; the suite was counted at ${String(suite)}`);
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
    if (/^\s*it\.each\b/m.test(file.text)) {
      throw new Error(`${file.name}: it.each cannot be counted by reading the file; write one it() per case`);
    }
    return sum + (file.text.match(/^\s*it\(/gm) ?? []).length;
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

export function main(args: string[]): number {
  const [folder, specs, ...rest] = args;
  if (folder === undefined || specs === undefined || rest.length > 0) {
    throw new Error('usage: node scripts/e2e-totals.ts <folder of run files> <folder of spec files>');
  }
  const suite = suiteCount(
    readdirSync(specs)
      .filter((name) => name.endsWith('.e2e.ts'))
      .map((name) => ({ name, text: readFileSync(`${specs}/${name}`, 'utf8') })),
  );
  const runs = byTarget(readRuns(folder));
  process.stdout.write(`e2e-totals: ${formatTotals(runs)} (suite ${String(suite)})\n`);
  const problems = totalsProblems(runs, suite);
  for (const problem of problems) process.stderr.write(`e2e-totals: ${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

await runIfEntry(import.meta.url, main);
