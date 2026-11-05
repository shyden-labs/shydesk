/**
 * One suite, every target, the same total (shyden-labs/shydesk#42 AC2).
 *
 * Each target's end-to-end run writes `<target>.json` with its counts into one
 * folder; this compares them, prints every target's total on one line, and
 * fails naming any target that ran fewer tests than another, skipped one, ran
 * none or reported twice.
 *
 *   node scripts/e2e-totals.ts <folder of run files>
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

/** Every way these runs fall short of one suite run unchanged on every target. */
export function totalsProblems(runs: readonly TargetRun[]): string[] {
  if (runs.length === 0) return ['no target reported a run'];
  const most = Math.max(...runs.map(total));
  const seen = new Set<string>();
  return [...runs]
    .sort((a, b) => a.target.localeCompare(b.target))
    .flatMap((run) => {
      const problems: string[] = [];
      if (seen.has(run.target)) problems.push(`${run.target} reported more than one run`);
      seen.add(run.target);
      if (total(run) === 0) problems.push(`${run.target} ran no tests`);
      else if (total(run) < most) problems.push(`${run.target} ran ${tests(total(run))}; another target ran ${String(most)}`);
      if (run.skipped > 0) problems.push(`${run.target} skipped ${tests(run.skipped)}`);
      return problems;
    })
    .filter((problem, index, all) => all.indexOf(problem) === index);
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
  const [folder, ...rest] = args;
  if (folder === undefined || rest.length > 0) throw new Error('usage: node scripts/e2e-totals.ts <folder of run files>');
  const runs = readRuns(folder);
  process.stdout.write(`e2e-totals: ${formatTotals(runs)}\n`);
  const problems = totalsProblems(runs);
  for (const problem of problems) process.stderr.write(`e2e-totals: ${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

await runIfEntry(import.meta.url, main);
