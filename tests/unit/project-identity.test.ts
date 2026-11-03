import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ShyDesk was made from repo-template, and two of the template's names were
 * left in place: SonarCloud scanned as `shyden-labs_repo-template`, so every
 * PR's scan failed with "Could not find the pullrequest" (shyden-labs/shydesk#6).
 */

describe('project identity', () => {
  it('scans SonarCloud as shyden-labs_shydesk', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci.match(/project-key: (\S+)/g)).toEqual(['project-key: shyden-labs_shydesk']);
  });

  it('names the package shydesk', () => {
    expect((JSON.parse(readFileSync('package.json', 'utf8')) as { name: string }).name).toBe('shydesk');
  });
});
