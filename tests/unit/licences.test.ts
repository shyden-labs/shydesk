import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { licenceProblems, licenceVerdict, type LockFile } from './licences.ts';

/**
 * The global licence rule (2026-10-07; purpose ruled 2026-11-09): a package is
 * refused only when using it would go against our own licence, so GPL, AGPL and
 * SSPL are refused, and an unknown licence, which cannot be judged. Permissive
 * licences and weak copyleft (LGPL, MPL) pass, shipped or not
 * (shyden-labs/repo-template#169).
 */

describe('licenceVerdict', () => {
  it.each(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', '0BSD', 'CC0-1.0', 'PSF-2.0', 'CC-BY-3.0'])(
    'passes the permissive %s',
    (licence) => {
      expect(licenceVerdict(licence)).toBe(true);
    },
  );

  it.each(['MPL-2.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later'])(
    'passes the weak copyleft %s',
    (licence) => {
      expect(licenceVerdict(licence)).toBe(true);
    },
  );

  it.each(['GPL-3.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0', 'UNLICENSED', 'SEE LICENSE IN LICENSE.md', '', undefined])(
    'refuses %s',
    (licence) => {
      expect(licenceVerdict(licence)).toBe(false);
    },
  );

  it('refuses an exception it does not know, since WITH changes the terms', () => {
    expect(licenceVerdict('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false);
  });

  it('refuses an expression it cannot read', () => {
    expect(licenceVerdict('(MIT OR')).toBe(false);
  });
});

describe('licenceVerdict reads SPDX expressions', () => {
  it('passes A OR B when one side passes', () => {
    expect(licenceVerdict('GPL-3.0-only OR MIT')).toBe(true);
  });

  it('refuses A OR B when neither side passes', () => {
    expect(licenceVerdict('GPL-3.0-only OR AGPL-3.0-only')).toBe(false);
  });

  it('passes A AND B when both sides pass', () => {
    expect(licenceVerdict('MIT AND MPL-2.0')).toBe(true);
  });

  it('refuses A AND B when one side fails', () => {
    expect(licenceVerdict('MIT AND GPL-3.0-only')).toBe(false);
  });

  it('reads parentheses, with AND binding tighter than OR', () => {
    expect(licenceVerdict('(MIT AND GPL-3.0-only) OR ISC')).toBe(true);
    expect(licenceVerdict('MIT AND (GPL-3.0-only OR ISC)')).toBe(true);
    expect(licenceVerdict('GPL-3.0-only OR ISC AND GPL-2.0-only')).toBe(false);
  });
});

describe('licenceProblems', () => {
  it("takes the licence recorded from the package's own files when its package.json names none", () => {
    const lock: LockFile = { packages: { '': {}, 'node_modules/css-value': { version: '0.0.1', dev: true } } };
    expect(licenceProblems(lock)).toEqual([]);
  });

  it('checks a new version of that package again, since the record is for one version', () => {
    const lock: LockFile = { packages: { '': {}, 'node_modules/css-value': { version: '0.0.2', dev: true } } };
    expect(licenceProblems(lock)).toEqual(['node_modules/css-value@0.0.2: no licence']);
  });

  const lock = (packages: LockFile['packages']): LockFile => ({ packages });

  it('names each refused package with its version and licence, shipped or build-only alike', () => {
    expect(
      licenceProblems(
        lock({
          '': { license: 'Apache-2.0' },
          'node_modules/ok': { version: '1.0.0', license: 'MIT', dev: true },
          'node_modules/gpl': { version: '2.0.0', license: 'GPL-3.0-only', dev: true },
          'node_modules/mpl': { version: '3.0.0', license: 'MPL-2.0' },
          'node_modules/agpl': { version: '3.1.0', license: 'AGPL-3.0-only' },
          'node_modules/a/node_modules/none': { version: '4.0.0' },
        }),
      ),
    ).toEqual([
      'node_modules/gpl@2.0.0: GPL-3.0-only',
      'node_modules/agpl@3.1.0: AGPL-3.0-only',
      'node_modules/a/node_modules/none@4.0.0: no licence',
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

  it('each carry a licence the global rule accepts', () => {
    expect(licenceProblems(lockFile)).toEqual([]);
  });
});
