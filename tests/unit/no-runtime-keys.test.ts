import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * No unit test generates a key at run time (shyden-labs/shydesk#209): RSA key
 * generation searches for random primes, so its time varies run to run and
 * once pushed tests/unit/access.test.ts's setup past the 1 s limit under
 * coverage. Tests import the fixed test-only keys in tests/fixtures/access-keys.ts.
 */

const UNIT = 'tests/unit';
const GENERATES = /\b(?:generateKeyPair|generateSecret)\s*\(|\bsubtle\.generateKey\s*\(|\bgenerateKeyPairSync\s*\(/;

describe('no unit test generates a key at run time', () => {
  it('finds no key generation in any unit test file', () => {
    const files = readdirSync(UNIT).filter((f) => f.endsWith('.ts') && f !== 'no-runtime-keys.test.ts');
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) =>
      readFileSync(`${UNIT}/${file}`, 'utf8')
        .split('\n')
        .flatMap((line, i) => (GENERATES.test(line) ? [`${file}:${i + 1} ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
