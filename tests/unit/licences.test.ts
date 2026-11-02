import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { licenceProblems, licenceVerdict, type LockFile } from './licences.ts';

/**
 * The global licence rule (2026-10-07): a shipped package is permissive; a
 * build or test tool may also be LGPL or MPL; GPL, AGPL, SSPL and unknown
 * licences are refused (shyden-labs/repo-template#169).
 */

describe('licenceVerdict for a shipped package', () => {
  it.each(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', '0BSD', 'CC0-1.0'])('passes %s', (licence) => {
    expect(licenceVerdict(licence, 'shipped')).toBe(true);
  });

  it.each(['MPL-2.0', 'LGPL-3.0-only', 'LGPL-2.1-or-later'])('refuses the weak copyleft %s', (licence) => {
    expect(licenceVerdict(licence, 'shipped')).toBe(false);
  });
});

describe('licenceVerdict for a build-only package', () => {
  it.each(['MIT', 'MPL-2.0', 'LGPL-3.0-only', 'LGPL-2.1-or-later'])('passes %s', (licence) => {
    expect(licenceVerdict(licence, 'build')).toBe(true);
  });
});

describe('licenceVerdict refuses wherever the package is used', () => {
  it.each(['GPL-3.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0', 'UNLICENSED', 'SEE LICENSE IN LICENSE.md', '', undefined])(
    'refuses %s',
    (licence) => {
      expect(licenceVerdict(licence, 'build')).toBe(false);
    },
  );

  it('refuses an exception it does not know, since WITH changes the terms', () => {
    expect(licenceVerdict('GPL-2.0-only WITH Classpath-exception-2.0', 'build')).toBe(false);
  });

  it('refuses an expression it cannot read', () => {
    expect(licenceVerdict('(MIT OR', 'build')).toBe(false);
  });
});

describe('licenceVerdict reads SPDX expressions', () => {
  it('passes A OR B when one side passes', () => {
    expect(licenceVerdict('GPL-3.0-only OR MIT', 'shipped')).toBe(true);
  });

  it('refuses A OR B when neither side passes', () => {
    expect(licenceVerdict('GPL-3.0-only OR AGPL-3.0-only', 'build')).toBe(false);
  });

  it('passes A AND B when both sides pass', () => {
    expect(licenceVerdict('MIT AND Apache-2.0', 'shipped')).toBe(true);
  });

  it('refuses A AND B when one side fails', () => {
    expect(licenceVerdict('MIT AND GPL-3.0-only', 'build')).toBe(false);
  });

  it('reads parentheses, with AND binding tighter than OR', () => {
    expect(licenceVerdict('(MIT AND GPL-3.0-only) OR ISC', 'shipped')).toBe(true);
    expect(licenceVerdict('MIT AND (GPL-3.0-only OR ISC)', 'shipped')).toBe(true);
    expect(licenceVerdict('GPL-3.0-only OR ISC AND GPL-2.0-only', 'shipped')).toBe(false);
  });
});

describe('licenceProblems', () => {
  const lock = (packages: LockFile['packages']): LockFile => ({ packages });

  it('names each refused package with its version, licence and use', () => {
    expect(
      licenceProblems(
        lock({
          '': { license: 'Apache-2.0' },
          'node_modules/ok': { version: '1.0.0', license: 'MIT', dev: true },
          'node_modules/gpl': { version: '2.0.0', license: 'GPL-3.0-only', dev: true },
          'node_modules/mpl': { version: '3.0.0', license: 'MPL-2.0' },
          'node_modules/a/node_modules/none': { version: '4.0.0' },
        }),
      ),
    ).toEqual([
      'node_modules/gpl@2.0.0 (build only): GPL-3.0-only',
      'node_modules/mpl@3.0.0 (shipped): MPL-2.0',
      'node_modules/a/node_modules/none@4.0.0 (shipped): no licence',
    ]);
  });

  it('counts a dev-optional package as shipped, since it can be installed for production', () => {
    expect(licenceProblems(lock({ 'node_modules/x': { version: '1.0.0', license: 'MPL-2.0', devOptional: true } }))).toEqual([
      'node_modules/x@1.0.0 (shipped): MPL-2.0',
    ]);
  });

  it('skips a linked workspace entry, which carries no licence of its own', () => {
    expect(licenceProblems(lock({ 'node_modules/ws': { resolved: 'packages/ws', link: true } }))).toEqual([]);
  });
});

describe('the installed packages', () => {
  const lockFile = JSON.parse(readFileSync('package-lock.json', 'utf8')) as LockFile;

  it('are read from a lockfile that lists them', () => {
    expect(Object.keys(lockFile.packages).length).toBeGreaterThan(1);
  });

  it('each carry a licence the global rule accepts for how they are used', () => {
    expect(licenceProblems(lockFile)).toEqual([]);
  });
});
