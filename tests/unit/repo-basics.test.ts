import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * What every repository created from this template inherits (Refs shyden-labs/repo-template#1): an
 * open-source licence naming Shyden Labs.
 *
 * The form follows the ASF's own guidance (Refs shyden-labs/repo-template#147): LICENSE is
 * https://www.apache.org/licenses/LICENSE-2.0.txt copied verbatim, and the copyright line lives in
 * a NOTICE file beside it (https://www.apache.org/legal/apply-license.html; Apache-2.0 section 4(d)).
 */

/** SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt, read 2026-10-31. */
const ASF_LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';

describe('the licence', () => {
  it('is the Apache-2.0 text, verbatim', () => {
    expect(createHash('sha256').update(readFileSync('LICENSE')).digest('hex')).toBe(ASF_LICENSE_SHA256);
  });

  it('opens with the licence title, not a copyright line', () => {
    const firstText = readFileSync('LICENSE', 'utf8')
      .split('\n')
      .find((line) => line.trim() !== '');
    expect(firstText?.trim()).toBe('Apache License');
  });
});

describe('the notice', () => {
  it('names Shyden Labs as the copyright holder', () => {
    expect(readFileSync('NOTICE', 'utf8').split('\n')[0]).toBe('Copyright 2026 Shyden Labs');
  });
});
