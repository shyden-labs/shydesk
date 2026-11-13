/**
 * After each integration test, prints the assertions it ran, counted by Vitest itself, so a
 * merge of tests is proven from a real run's output (shyden-labs/shydesk#132).
 */
import { afterEach, expect } from 'vitest';
import { assertionLine } from './assertion-line.ts';

afterEach(() => {
  const { currentTestName, assertionCalls } = expect.getState();
  process.stdout.write(assertionLine(currentTestName, assertionCalls));
});
