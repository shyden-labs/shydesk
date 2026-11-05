import type { ViteUserConfig } from 'vitest/config';
import { failOnWarnings } from './tests/setup/warnings.ts';

// The integration suite: tests under tests/integration against real services
// on ShyDesk Non-Prod, run in CI only (the laptop runs unit tests alone).
// One request to D1 takes well under a second; 10 s per test covers a slow
// round trip without hiding a hang.
export default {
  plugins: [failOnWarnings],
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 60_000,
  },
} satisfies ViteUserConfig;
