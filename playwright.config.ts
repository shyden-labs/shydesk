/**
 * The e2e suite on Playwright, through the shared device layer (shyden-labs/shydesk#176):
 * every desktop browser shyden-labs/playwright-devices gives, each a real desktop browser
 * with no phone emulation. One local ShyDesk and its database serve the run, so tests run
 * one at a time.
 *
 *   npm run test:e2e:pw   (CI's e2e-playwright job; the laptop runs no e2e suite)
 */
import { defineConfig } from '@playwright/test';
import { desktopProjects } from '@shyden-labs/playwright-devices/desktop';
import { SUITE_BASE } from './tests/e2e-pw/global-setup.ts';

export default defineConfig({
  testDir: 'tests/e2e-pw',
  testMatch: '**/*.spec.ts',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: '.e2e-runs/playwright-output',
  globalSetup: './tests/e2e-pw/global-setup.ts',
  use: { baseURL: SUITE_BASE },
  reporter: [
    ['list'],
    ['json', { outputFile: '.e2e-runs/playwright-report.json' }],
    ['@shyden-labs/playwright-devices/assertion-counter', { outputFile: '.e2e-runs/assertions.json', unnamedTarget: 'desktop' }],
  ],
  projects: desktopProjects(),
});
