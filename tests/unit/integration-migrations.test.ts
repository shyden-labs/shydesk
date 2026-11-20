import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../integration/global-setup.ts';

// The integration database is built from a hand-kept list; a migration missing
// from it leaves its tables out of every integration run (shyden-labs/shydesk#232,
// where 0006_notices.sql was missed).
describe('the integration database migrations', () => {
  it('lists every file in migrations/, in order', () => {
    const files = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => `migrations/${f}`);
    expect(MIGRATIONS).toEqual(files);
  });
});

// Most integration tests are journeys of 10–30 REST calls to D1 at up to about 2 s each on a slow day; a
// 10 s limit failed correct changes (shyden-labs/shydesk#247). A hang still fails, at a minute.
describe('the integration time limit', () => {
  it("gives each test a journey's time, a minute", async () => {
    const { default: integration } = await import('../../vitest.integration.config.ts');
    expect(integration.test.testTimeout).toBe(60_000);
  });
});
