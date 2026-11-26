/**
 * Starts what the Playwright suite needs once, before any browser opens: the same local
 * ShyDesk, pages and sign-in key as the WebdriverIO run (shyden-labs/shydesk#176).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { startSuite } from '../e2e/harness/suite-start.ts';

const RUNS = '.e2e-runs';
const PORT = 8765;
export const SUITE_BASE = process.env.E2E_ORIGIN ?? `http://localhost:${String(PORT)}`;

/** Playwright calls the function this returns once every test has run. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  rmSync(RUNS, { recursive: true, force: true });
  mkdirSync(RUNS);
  const suite = await startSuite({ runsDir: RUNS, port: PORT, base: SUITE_BASE, suiteOrigins: [SUITE_BASE] });
  return () => suite.stop();
}
