import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { byTarget, formatTotals, main, readRuns, totalsProblems, type TargetRun } from '../../scripts/e2e-totals.ts';

// The run files are stood in: a unit test reads nothing from disk here.
vi.mock('node:fs', () => ({ readdirSync: vi.fn(), readFileSync: vi.fn() }));
const dir = vi.mocked(readdirSync) as unknown as ReturnType<typeof vi.fn<(path: string) => string[]>>;
const read = vi.mocked(readFileSync) as unknown as ReturnType<typeof vi.fn<(path: string) => string>>;

/**
 * One suite, every target, the same total (shyden-labs/shydesk#42 AC2). Each
 * target's run writes its counts; these checks compare them and name any
 * target that ran fewer tests or skipped one.
 */

const run = (target: string, passed: number, failed = 0, skipped = 0): TargetRun => ({ target, passed, failed, skipped });

describe('totalsProblems', () => {
  it('passes equal totals with nothing skipped', () => {
    expect(totalsProblems([run('chromium', 10), run('firefox', 9, 1), run('android', 10)])).toEqual([]);
  });

  it('counts a failed test in the total, so a red test is not a short run', () => {
    expect(totalsProblems([run('chromium', 10), run('ios', 7, 3)])).toEqual([]);
  });

  it('names a target that ran fewer tests than the others', () => {
    expect(totalsProblems([run('chromium', 10), run('firefox', 10), run('ios', 9)])).toEqual(['ios ran 9 tests; another target ran 10']);
  });

  it('names every short target', () => {
    expect(totalsProblems([run('chromium', 10), run('android', 8), run('ios', 9)])).toEqual([
      'android ran 8 tests; another target ran 10',
      'ios ran 9 tests; another target ran 10',
    ]);
  });

  it('names a target that skipped a test, even when its total matches', () => {
    expect(totalsProblems([run('chromium', 10), run('safari', 9, 0, 1)])).toEqual(['safari skipped 1 test']);
  });

  it('names a target that ran no tests', () => {
    expect(totalsProblems([run('chromium', 0)])).toEqual(['chromium ran no tests']);
  });

  it('fails when no target reported at all', () => {
    expect(totalsProblems([])).toEqual(['no target reported a run']);
  });
});

describe('byTarget', () => {
  it('adds up the runs of each target, one per spec file', () => {
    expect(byTarget([run('ios', 3, 1), run('android', 4), run('ios', 5, 0, 1)])).toEqual([run('android', 4), run('ios', 8, 1, 1)]);
  });
});

describe('formatTotals', () => {
  it('prints each target and its total on one line, in target order', () => {
    expect(formatTotals([run('ios', 10), run('chromium', 9, 1), run('android', 10, 0, 2)])).toBe('android 12 · chromium 10 · ios 10');
  });
});

describe('readRuns', () => {
  it('reads every .json run file in the folder', () => {
    dir.mockReturnValue(['chromium.json', 'notes.txt', 'ios.json']);
    read.mockImplementation((path: string) => JSON.stringify(run(path.includes('ios') ? 'ios' : 'chromium', 10)));
    expect(readRuns('runs')).toEqual([run('chromium', 10), run('ios', 10)]);
    expect(read).toHaveBeenCalledWith('runs/chromium.json', 'utf8');
  });

  it('refuses a run file without whole counts, naming it', () => {
    dir.mockReturnValue(['bad.json']);
    read.mockReturnValue(JSON.stringify({ target: 'ios', passed: 'ten', failed: 0, skipped: 0 }));
    expect(() => readRuns('runs')).toThrow('runs/bad.json is not a run: {target, passed, failed, skipped}');
  });

  it.each([
    ['a negative count', { target: 'ios', passed: -1, failed: 0, skipped: 0 }],
    ['a fractional count', { target: 'ios', passed: 1.5, failed: 0, skipped: 0 }],
    ['an empty target name', { target: '', passed: 1, failed: 0, skipped: 0 }],
    ['null', null],
    ['a bare number', 10],
  ])('refuses a run file holding %s', (_name, value) => {
    dir.mockReturnValue(['bad.json']);
    read.mockReturnValue(JSON.stringify(value));
    expect(() => readRuns('runs')).toThrow('runs/bad.json is not a run');
  });

  it('refuses a run file without a target name', () => {
    dir.mockReturnValue(['bad.json']);
    read.mockReturnValue(JSON.stringify({ passed: 1, failed: 0, skipped: 0 }));
    expect(() => readRuns('runs')).toThrow('runs/bad.json is not a run');
  });
});

describe('main', () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds each target's spec-file runs together before comparing", () => {
    dir.mockReturnValue(['ios-0-0.json', 'ios-0-1.json', 'android-1-0.json']);
    read.mockImplementation((path: string) => JSON.stringify(path.includes('android') ? run('android', 10) : run('ios', 5)));
    expect(main(['runs'])).toBe(0);
    expect(out).toHaveBeenCalledWith('e2e-totals: android 10 · ios 10\n');
  });

  it('prints the totals and exits 0 when they agree', () => {
    dir.mockReturnValue(['a.json', 'b.json']);
    read.mockImplementation((path: string) => JSON.stringify(run(path.includes('a.json') ? 'android' : 'ios', 10)));
    expect(main(['runs'])).toBe(0);
    expect(out).toHaveBeenCalledWith('e2e-totals: android 10 · ios 10\n');
    expect(err).not.toHaveBeenCalled();
  });

  it('prints each problem and exits 1 when they differ', () => {
    dir.mockReturnValue(['a.json', 'b.json']);
    read.mockImplementation((path: string) => JSON.stringify(path.includes('a.json') ? run('android', 10) : run('ios', 9)));
    expect(main(['runs'])).toBe(1);
    expect(out).toHaveBeenCalledWith('e2e-totals: android 10 · ios 9\n');
    expect(err).toHaveBeenCalledWith('e2e-totals: ios ran 9 tests; another target ran 10\n');
  });

  it.each([[[]], [['a', 'b']]])('refuses %j as arguments', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/e2e-totals.ts <folder of run files>');
  });
});
