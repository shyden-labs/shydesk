import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../integration/global-setup.ts';

// The integration database is built from MIGRATIONS (tests/integration/global-setup.ts), so a
// migration missing from that list leaves the suite on an old schema (CI run 42678743933:
// "table products has no column named privacy_url_en", shyden-labs/shydesk#78).
describe('the integration database', () => {
  it('applies every migration in migrations/, in order', () => {
    const files = readdirSync(new URL('../../migrations', import.meta.url))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => `migrations/${name}`);
    expect(MIGRATIONS).toEqual(files);
  });
});
