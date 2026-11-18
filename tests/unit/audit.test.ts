import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { advisories, main, problems, type AuditException } from '../../scripts/audit.ts';

// npm and the exceptions file are stood in: a unit test starts no process.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:fs', async (real) => ({ ...(await real<typeof import('node:fs')>()), readFileSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const read = vi.mocked(readFileSync);

/**
 * CI's audit (shyden-labs/shydesk#203): any known vulnerability fails, except an
 * advisory Shyden excepted by name until its expiry (2026-11-18 ruling on
 * GHSA-fc5q-39xc-vjpf, picomatch, no patched version).
 */

const PICOMATCH = 'GHSA-fc5q-39xc-vjpf';

const report = (...via: { url: string; name: string; severity: string }[]): string =>
  JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      fdir: { severity: 'high', via: ['picomatch'] },
      ...Object.fromEntries(via.map((v) => [v.name, { severity: v.severity, via: [{ source: 1, ...v, title: 't', range: '*' }] }])),
    },
  });

const advisory = (id: string, name: string, severity = 'high') => ({ url: `https://github.com/advisories/${id}`, name, severity });

const EXCEPTION: AuditException = {
  advisory: PICOMATCH,
  package: 'picomatch',
  expires: '2026-12-01',
  ticket: 'shyden-labs/shydesk#203',
  why: 'no patched version; dev tooling only',
};

const ran = (stdout: string, status = 1): SpawnSyncReturns<string> => ({ pid: 1, output: [], stdout, stderr: '', status, signal: null });

describe('advisories', () => {
  it('lists each advisory once, by id and package, ignoring packages that only depend on one', () => {
    expect(advisories(report(advisory(PICOMATCH, 'picomatch'), advisory('GHSA-aaaa-bbbb-cccc', 'left-pad', 'low')))).toEqual([
      { id: PICOMATCH, package: 'picomatch', severity: 'high' },
      { id: 'GHSA-aaaa-bbbb-cccc', package: 'left-pad', severity: 'low' },
    ]);
  });

  it('leaves out info-level advisories, as --audit-level=low did', () => {
    expect(advisories(report(advisory('GHSA-iiii-iiii-iiii', 'noise', 'info')))).toEqual([]);
  });

  it('finds nothing in a clean report', () => {
    expect(advisories(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }))).toEqual([]);
  });

  it('refuses output that is not an npm audit report, naming it', () => {
    expect(() => advisories('npm error code ENOLOCK')).toThrow('npm audit did not print a JSON report');
    expect(() => advisories('{"error":{"code":"ENOAUDIT"}}')).toThrow('npm audit did not print a JSON report');
  });
});

describe('problems', () => {
  const found = [{ id: PICOMATCH, package: 'picomatch', severity: 'high' }];

  it('passes an excepted advisory before its expiry', () => {
    expect(problems(found, [EXCEPTION], '2026-11-30')).toEqual([]);
  });

  it('fails an excepted advisory on its expiry day, naming the ticket', () => {
    expect(problems(found, [EXCEPTION], '2026-12-01')).toEqual([
      `${PICOMATCH} (picomatch, high): its exception expired on 2026-12-01 (shyden-labs/shydesk#203)`,
    ]);
  });

  it('fails any advisory with no exception, naming it', () => {
    expect(problems([{ id: 'GHSA-aaaa-bbbb-cccc', package: 'left-pad', severity: 'low' }], [EXCEPTION], '2026-11-18')).toEqual([
      'GHSA-aaaa-bbbb-cccc (left-pad, low): no exception',
    ]);
  });

  it('does not let an exception cover the same advisory in another package', () => {
    expect(problems([{ id: PICOMATCH, package: 'micromatch', severity: 'high' }], [EXCEPTION], '2026-11-18')).toEqual([
      `${PICOMATCH} (micromatch, high): no exception`,
    ]);
  });
});

describe('the exceptions file', () => {
  it('excepts only GHSA-fc5q-39xc-vjpf in picomatch, and has not expired', async () => {
    const { readFileSync: realRead } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const file = JSON.parse(realRead(new URL('../../audit-exceptions.json', import.meta.url), 'utf8')) as { exceptions: AuditException[] };
    expect(file.exceptions.map((e) => [e.advisory, e.package, e.expires, e.ticket])).toEqual([
      [PICOMATCH, 'picomatch', '2026-12-01', 'shyden-labs/shydesk#203'],
    ]);
    const today = new Date().toISOString().slice(0, 10);
    for (const e of file.exceptions) expect(today < e.expires, `${e.advisory} expired on ${e.expires}`).toBe(true);
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00Z'), toFake: ['Date'] });
    read.mockReturnValue(JSON.stringify({ exceptions: [EXCEPTION] }));
  });

  it('runs npm audit as JSON and passes when every advisory is excepted', () => {
    spawn.mockReturnValue(ran(report(advisory(PICOMATCH, 'picomatch'))));
    expect(main()).toBe(0);
    // npm is the CLI shipped beside this node, run by node's own path: PATH is never searched (Sonar S4036).
    const npmCli = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(spawn).toHaveBeenCalledWith(process.execPath, [npmCli, 'audit', '--json'], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('fails naming each advisory that is not excepted', () => {
    spawn.mockReturnValue(ran(report(advisory(PICOMATCH, 'picomatch'), advisory('GHSA-aaaa-bbbb-cccc', 'left-pad'))));
    expect(() => main()).toThrow('npm audit found 1 advisory not allowed:\nGHSA-aaaa-bbbb-cccc (left-pad, high): no exception');
  });

  it('fails naming every advisory that is not excepted, counted', () => {
    spawn.mockReturnValue(ran(report(advisory('GHSA-aaaa-bbbb-cccc', 'left-pad'), advisory('GHSA-dddd-eeee-ffff', 'is-odd', 'moderate'))));
    expect(() => main()).toThrow(
      'npm audit found 2 advisories not allowed:\nGHSA-aaaa-bbbb-cccc (left-pad, high): no exception\nGHSA-dddd-eeee-ffff (is-odd, moderate): no exception',
    );
  });

  it('fails closed when npm did not run, naming why', () => {
    spawn.mockReturnValue({ ...ran(''), error: new Error('spawn npm ENOENT') });
    expect(() => main()).toThrow('npm audit did not run: spawn npm ENOENT');
  });
});
