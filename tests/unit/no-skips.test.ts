import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isRunnerConfig, skipsIn, suiteFiles } from './no-skips.ts';

/**
 * One suite, run unchanged on every target, nothing skipped (shyden-labs/shydesk#42 AC3).
 * Every target runs every test, so no test file or runner config may skip,
 * focus or exclude a test, for one target or for all of them.
 */

describe('skipsIn finds every way to leave a test out', () => {
  it.each([
    ['a skipped test', "it.skip('x', () => {});"],
    ['a skipped suite', "describe.skip('x', () => {});"],
    ['a conditional skip', "it.skipIf(isIos)('x', () => {});"],
    ['a conditional run', "test.runIf(isAndroid)('x', () => {});"],
    ['a focused test, which skips the rest', "it.only('x', () => {});"],
    ['a to-do test', "it.todo('x');"],
    ['a fixme test', "test.fixme('x', () => {});"],
    ['an x-prefixed test', "xit('x', () => {});"],
    ['an x-prefixed suite', "xdescribe('x', () => {});"],
    ['a skip from inside a test', 'this.skip();'],
    ['a pending call', "pending('later');"],
  ])('finds %s', (_name, line) => {
    expect(skipsIn(`const a = 1;\n${line}\n`, 'test')).toEqual([2]);
  });

  it.each([
    ['an inverted grep', "mochaOpts: { invertGrep: true, grep: '@ios' },"],
    ['a grepInvert option', 'grepInvert: /@android/,'],
    ['a testIgnore option', "testIgnore: ['**/phone/**'],"],
    ['an exclude list', "exclude: ['./tests/e2e/upload.e2e.ts'],"],
    ['a grep filter', "grep: '@desktop',"],
  ])('finds %s in a runner config', (_name, line) => {
    expect(skipsIn(`export const config = {\n${line}\n};`, 'config')).toEqual([2]);
  });

  it('finds a skip below a multi-line block comment on its own line', () => {
    expect(skipsIn("/*\n note\n*/\nit.skip('x', () => {});", 'test')).toEqual([4]);
  });

  it.each([
    ['a skip named in a line comment', "// it.skip('x') is refused here"],
    ['a skip named in a block comment', '/* describe.skip is refused */'],
    ['an ordinary test', "it('skips nothing', () => {});"],
    ['a table of cases', "it.each([[1]])('case %s', () => {});"],
    ['a word that only contains skip', 'const skipped = false;'],
    ['a skip named in a string', "const why = 'it.skip is refused';"],
    ['an exclude key in test data', "const rule = { include: ['main'], exclude: [] };"],
  ])('ignores %s', (_name, line) => {
    expect(skipsIn(line, 'test')).toEqual([]);
  });

  it.each([
    ['vitest.unit.config.ts', true],
    ['wdio.conf.ts', true],
    ['tests/e2e/wdio.android.conf.ts', true],
    ['tests/unit/no-skips.test.ts', false],
  ])('treats %s as a runner config: %s', (file, expected) => {
    expect(isRunnerConfig(file)).toBe(expected);
  });
});

describe('the repository', () => {
  it('reads at least this file, so an empty scan cannot pass', () => {
    expect(suiteFiles()).toContain('tests/unit/no-skips.test.ts');
  });

  it.each(suiteFiles())('%s leaves no test out', (file) => {
    expect(skipsIn(readFileSync(file, 'utf8'), isRunnerConfig(file) ? 'config' : 'test')).toEqual([]);
  });
});
