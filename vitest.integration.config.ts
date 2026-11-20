import type { ViteUserConfig } from 'vitest/config';
import { failOnWarnings } from './tests/setup/warnings.ts';

// The integration suite: tests under tests/integration against real services
// on ShyDesk Non-Prod, run in CI only (the laptop runs unit tests alone).
// Most tests are journeys of 10–30 calls to D1's REST API, each up to about
// 2 s on a slow day, so a minute per test covers a slow journey without hiding
// a hang (shyden-labs/shydesk#247: 10 s failed correct changes on a slow day).
export default {
  plugins: [failOnWarnings],
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    // Prints the assertions each test ran (shyden-labs/shydesk#132).
    setupFiles: ['tests/integration/assertion-log.ts'],
    // One shared database: a file reading the running total must not see another file change it.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
} satisfies ViteUserConfig;
