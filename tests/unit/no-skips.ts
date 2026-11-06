import { readdirSync } from 'node:fs';
import { withoutTsComments } from './source-text.ts';

/**
 * Finds every way a test file or runner config can leave a test out
 * (shyden-labs/shydesk#42 AC3): skipped, conditional, focused, to-do and
 * fixme tests, x-prefixed tests, a skip from inside a test, and runner
 * options that filter tests (grep, inverted grep, ignore and exclude lists).
 *
 * Comments and string contents are blanked first, so a skip only named in
 * prose or in a sample string is not one. Each pattern is written so that its
 * own source text does not match it, which keeps this file in the scan.
 */
const IN_TESTS: readonly RegExp[] = [
  /\b(?:it|test|describe|suite|context|bench)\.(?:skip|skipIf|runIf|only|todo|fixme)\b/,
  /\bx(?:it|describe|test|context)\s*\(/,
  /\bthis\.skip\s*\(/,
  /\bpending\s*\(/,
  /\b(?:invert)Grep\b|\bgrep(?:Invert)\b|\btest(?:Ignore)\b/,
];

/** Runner options that filter tests; only a runner config is read for these, as test data may use the same keys. */
const IN_CONFIGS: readonly RegExp[] = [...IN_TESTS, /\b(?:exclude|grep)\s*:/];

/** Each quoted or template string with its contents blanked; newlines are kept. */
function withoutStringContents(code: string): string {
  return code.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g, (literal) => literal.replace(/[^\n]/g, ' '));
}

/** The 1-based line numbers of `source`, a test file or a runner config, that leave a test out. */
export function skipsIn(source: string, kind: 'test' | 'config'): number[] {
  const patterns = kind === 'config' ? IN_CONFIGS : IN_TESTS;
  const code = withoutStringContents(withoutTsComments(source));
  return code.split('\n').flatMap((line, index) => (patterns.some((pattern) => pattern.test(line)) ? [index + 1] : []));
}

/** A runner config: `*.config.*` or `*.conf.*`, anywhere in the repository. */
export function isRunnerConfig(file: string): boolean {
  return /\.conf(?:ig)?\.(?:ts|js|mjs|cjs)$/.test(file);
}

const SCRIPT = /\.(?:ts|js|mjs|cjs)$/;

/** Every test file and runner config in the repository, as sorted relative paths. */
export function suiteFiles(): string[] {
  const tests = readdirSync('tests', { recursive: true, encoding: 'utf8' })
    .map((path) => `tests/${path.replaceAll('\\', '/')}`)
    .filter((path) => SCRIPT.test(path));
  const configs = readdirSync('.').filter(isRunnerConfig);
  return [...tests, ...configs].sort();
}
