/**
 * The integration suite prints the assertions each test ran, so a merge of tests is
 * proven from a real run (shyden-labs/shydesk#132).
 */
import { describe, expect, it } from 'vitest';
import integration from '../../vitest.integration.config.ts';
import { assertionLine } from '../integration/assertion-line.ts';

describe('the integration assertion log', () => {
  it('names the test and the assertions it ran', () => {
    expect(assertionLine('schema > indexes > lists tickets', 3)).toBe('assertions-ran: schema > indexes > lists tickets = 3\n');
  });

  it('names a test with no name, and one that ran none', () => {
    expect(assertionLine(undefined, 0)).toBe('assertions-ran: (unnamed) = 0\n');
  });

  it('runs after every integration test', () => {
    expect(integration.test.setupFiles).toEqual(['tests/integration/assertion-log.ts']);
  });
});
