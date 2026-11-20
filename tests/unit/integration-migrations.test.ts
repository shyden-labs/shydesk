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
