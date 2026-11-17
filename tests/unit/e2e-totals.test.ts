import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  byTarget,
  formatTotals,
  groupCounts,
  groupOf,
  main,
  readRuns,
  suiteCount,
  totalsProblems,
  type TargetRun,
} from '../../scripts/e2e-totals.ts';

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
/** The same count for both groups: a suite with no group-only tests. */
const both = (count: number) => ({ phone: count, desktop: count });

describe('totalsProblems', () => {
  it('passes equal totals with nothing skipped', () => {
    expect(totalsProblems([run('chromium', 10), run('firefox', 9, 1), run('android', 10)], both(10))).toEqual([]);
  });

  it('counts a failed test in the total, so a red test is not a short run', () => {
    expect(totalsProblems([run('chromium', 10), run('ios', 7, 3)], both(10))).toEqual([]);
  });

  it('names a target that ran fewer tests than the others', () => {
    expect(totalsProblems([run('chromium', 10), run('firefox', 10), run('ios', 9)], both(10))).toEqual([
      'ios ran 9 tests; the phone group has 10',
    ]);
  });

  it('names every short target', () => {
    expect(totalsProblems([run('chromium', 10), run('android', 8), run('ios', 9)], both(10))).toEqual([
      'android ran 8 tests; the phone group has 10',
      'ios ran 9 tests; the phone group has 10',
    ]);
  });

  it('names a target that skipped a test, even when its total matches', () => {
    expect(totalsProblems([run('chromium', 10), run('safari', 9, 0, 1)], both(10))).toEqual(['safari skipped 1 test']);
  });

  it('names a target that ran no tests', () => {
    expect(totalsProblems([run('chromium', 0)], both(10))).toEqual(['chromium ran no tests']);
  });

  it('fails when no target reported at all', () => {
    expect(totalsProblems([], both(10))).toEqual(['no target reported a run']);
  });

  it('names targets that ran fewer tests than the suite has, even when they agree with each other', () => {
    expect(totalsProblems([run('android', 3), run('ios', 3)], both(4))).toEqual([
      'android ran 3 tests; the phone group has 4',
      'ios ran 3 tests; the phone group has 4',
    ]);
  });

  it('names a target that ran more tests than the suite was counted to have, so a miscount cannot hide a short run', () => {
    expect(totalsProblems([run('chromium', 5)], both(4))).toEqual(['chromium ran 5 tests; the desktop group was counted at 4']);
  });

  it("holds each target to its own group's count (shyden-labs/shydesk#175)", () => {
    expect(totalsProblems([run('chromium', 5), run('safari', 5), run('android', 4), run('ios', 4)], { phone: 4, desktop: 5 })).toEqual([]);
  });

  it('names a phone short of the phone group, even when the desktop group has fewer tests', () => {
    expect(totalsProblems([run('chromium', 3), run('ios', 3)], { phone: 4, desktop: 3 })).toEqual([
      'ios ran 3 tests; the phone group has 4',
    ]);
  });

  it('names a browser short of the desktop group', () => {
    expect(totalsProblems([run('firefox', 4), run('android', 5)], { phone: 5, desktop: 5 })).toEqual([
      'firefox ran 4 tests; the desktop group has 5',
    ]);
  });

  it('still names a target behind another when a miscount put the suite below both', () => {
    expect(totalsProblems([run('chromium', 5), run('firefox', 4)], both(4))).toEqual([
      'chromium ran 5 tests; the desktop group was counted at 4',
      'firefox ran 4 tests; another target ran 5',
    ]);
  });
});

describe('groupOf', () => {
  it.each([
    ['chromium', 'desktop'],
    ['firefox', 'desktop'],
    ['safari', 'desktop'],
    ['android', 'phone'],
    ['ios', 'phone'],
  ])('puts %s in the %s group', (target, group) => {
    expect(groupOf(target)).toBe(group);
  });

  it('refuses a target in no group, naming it', () => {
    expect(() => groupOf('ipad')).toThrow('ipad is in no device group (phone: android, ios; desktop: chromium, firefox, safari)');
  });
});

describe('groupCounts (shyden-labs/shydesk#175)', () => {
  const spec = (name: string, tests: number, header = ''): { name: string; text: string } => ({
    name,
    text: header + "  it('t', async () => {});\n".repeat(tests),
  });

  it('counts shared tests in both groups', () => {
    expect(groupCounts([spec('a.e2e.ts', 3), spec('b.e2e.ts', 1)])).toEqual({ phone: 4, desktop: 4 });
  });

  it("adds a group-only file's tests to its own group only", () => {
    expect(
      groupCounts([
        spec('a.e2e.ts', 3),
        spec('keys.desktop.e2e.ts', 2, '// desktop-only: hardware keyboard shortcuts\n'),
        spec('turn.phone.e2e.ts', 1, '// phone-only: screen orientation\n'),
      ]),
    ).toEqual({ phone: 4, desktop: 5 });
  });

  it('refuses a group-only file with no reason line, naming it', () => {
    expect(() => groupCounts([spec('keys.desktop.e2e.ts', 1)])).toThrow(
      'keys.desktop.e2e.ts runs on desktop only but gives no reason: its first line must be "// desktop-only: <the input or feature that differs>"',
    );
  });

  it('refuses a reason line with no reason in it', () => {
    expect(() => groupCounts([spec('turn.phone.e2e.ts', 1, '// phone-only:   \n')])).toThrow(
      'turn.phone.e2e.ts runs on phone only but gives no reason',
    );
  });

  it("refuses a reason line for the other group, so a file's tag and reason agree", () => {
    expect(() => groupCounts([spec('turn.phone.e2e.ts', 1, '// desktop-only: hardware keyboard\n')])).toThrow(
      'turn.phone.e2e.ts runs on phone only but gives no reason',
    );
  });

  it('refuses any other device tag, naming it, since only the phone and desktop groups exist', () => {
    expect(() => groupCounts([spec('viewer.ios.e2e.ts', 1, '// ios-only: x\n')])).toThrow(
      'viewer.ios.e2e.ts: "ios" is not a device group; a test runs everywhere, or is tagged phone or desktop',
    );
  });
});

describe('suiteCount', () => {
  it('counts every test in every spec file', () => {
    expect(
      suiteCount([
        { name: 'a.e2e.ts', text: "describe('a', () => {\n  it('one', async () => {});\n  it(\"two\", async () => {});\n});\n" },
        { name: 'b.e2e.ts', text: "describe('b', () => {\n  it(`three`, async () => {});\n});\n" },
      ]),
    ).toBe(3);
  });

  it('counts a spec file with no tests as none', () => {
    expect(suiteCount([{ name: 'd.e2e.ts', text: "describe('d', () => {});\n" }])).toBe(0);
  });

  it('refuses a spec file whose tests cannot be counted by reading it, naming the file', () => {
    expect(() => suiteCount([{ name: 'c.e2e.ts', text: "  it.each([1, 2])('x %s', async () => {});\n" }])).toThrow(
      'c.e2e.ts: it.each cannot be counted by reading the file; write one it() per case',
    );
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

  /** A suite folder of one spec file with `count` tests, and a runs folder of `files`. */
  const folders = (count: number, files: Record<string, TargetRun>): void => {
    dir.mockImplementation((path: string) => (path === 'suite' ? ['one.e2e.ts', 'helper.ts'] : Object.keys(files)));
    read.mockImplementation((path: string) => {
      if (path === 'suite/one.e2e.ts') return "  it('t', async () => {});\n".repeat(count);
      const file = files[path.replace('runs/', '')];
      if (file === undefined) throw new Error(`read ${path}`);
      return JSON.stringify(file);
    });
  };

  it("adds each target's spec-file runs together before comparing", () => {
    folders(10, { 'ios-0-0.json': run('ios', 5), 'ios-0-1.json': run('ios', 5), 'android-1-0.json': run('android', 10) });
    expect(main(['runs', 'suite'])).toBe(0);
    expect(out).toHaveBeenCalledWith('e2e-totals: android 10 · ios 10 (phone 10 · desktop 10)\n');
  });

  it('prints the totals and exits 0 when they agree with the suite', () => {
    folders(10, { 'a.json': run('android', 10), 'b.json': run('ios', 10) });
    expect(main(['runs', 'suite'])).toBe(0);
    expect(out).toHaveBeenCalledWith('e2e-totals: android 10 · ios 10 (phone 10 · desktop 10)\n');
    expect(err).not.toHaveBeenCalled();
  });

  it('prints each problem and exits 1 when a target is short', () => {
    folders(10, { 'a.json': run('android', 10), 'b.json': run('ios', 9) });
    expect(main(['runs', 'suite'])).toBe(1);
    expect(out).toHaveBeenCalledWith('e2e-totals: android 10 · ios 9 (phone 10 · desktop 10)\n');
    expect(err).toHaveBeenCalledWith('e2e-totals: ios ran 9 tests; the phone group has 10\n');
  });

  it('exits 1 when the targets agree with each other but are short of the suite', () => {
    folders(4, { 'a.json': run('android', 3), 'b.json': run('ios', 3) });
    expect(main(['runs', 'suite'])).toBe(1);
    expect(err).toHaveBeenCalledWith('e2e-totals: android ran 3 tests; the phone group has 4\n');
    expect(err).toHaveBeenCalledWith('e2e-totals: ios ran 3 tests; the phone group has 4\n');
  });

  it.each([[[]], [['a']], [['a', 'b', 'c']]])('refuses %j as arguments', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/e2e-totals.ts <folder of run files> <folder of spec files>');
  });
});
