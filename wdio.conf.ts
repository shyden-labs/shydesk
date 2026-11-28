/**
 * The end-to-end suite on the real phones, run unchanged on each (shyden-labs/shydesk#42).
 * Desktop browsers run the same journeys on Playwright: `npm run test:e2e:pw` (shyden-labs/shydesk#176).
 *
 *   E2E_TARGETS=android,ios E2E_ORIGIN=http://<this Mac's LAN address>:8765 \
 *     E2E_IOS_UDID=<udid> E2E_ANDROID_SERIAL=<serial> \
 *     E2E_CHROMEDRIVER=<chromedriver for the phone's Chrome> npm run test:e2e:device   (real phones over USB, Appium on 4723)
 *
 * Every target runs every spec file. Each worker writes its counts to
 * `.e2e-runs/`, and `scripts/e2e-totals.ts` prints the total per target and
 * fails naming any target that ran fewer tests.
 *
 * Before any target starts, a local ShyDesk runs this branch's Worker on port
 * 8787 (tests/e2e/harness/local-shydesk.ts), and /contact.html serves the demo
 * page with its piece loaded from it (shyden-labs/shydesk#19).
 */
import type { Capabilities, Options } from '@wdio/types';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { capabilitiesFor, otherGroupSpecs, suiteOriginFor, targetOf, targetsFrom, type TargetEnv } from './tests/e2e/harness/targets.ts';
import { driver } from './tests/e2e/harness/driver.ts';
import { startSuite, type SuiteHandle } from './tests/e2e/harness/suite-start.ts';
import { savePhoneScreen, supportPieceState } from './tests/e2e/harness/report.ts';
import { FORWARD_PORTS, adbProblem, checkForwards, setForwards, type Adb } from './tests/e2e/harness/adb-forwards.ts';
import { commandPath, FIXED_DIRS } from './scripts/command-path.ts';
/** adb from the Android SDK first (ANDROID_HOME, then its default place), then the fixed folders (shyden-labs/shydesk#291). */
const ADB_DIRS = [
  ...(process.env.ANDROID_HOME ? [join(process.env.ANDROID_HOME, 'platform-tools')] : []),
  join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools'),
  ...FIXED_DIRS,
];

const RUNS = '.e2e-runs';
const PORT = 8765;
const BASE = process.env.E2E_ORIGIN ?? `http://localhost:${String(PORT)}`;

const targets = targetsFrom(process.env.E2E_TARGETS ?? '');
// Only variables that are set are passed on, so a missing one is refused by name.
const targetEnv = Object.fromEntries(
  Object.entries({
    chromedriver: process.env.E2E_CHROMEDRIVER,
    iosUdid: process.env.E2E_IOS_UDID,
    androidSerial: process.env.E2E_ANDROID_SERIAL,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined),
) as TargetEnv;
const appium = { hostname: '127.0.0.1', port: 4723, path: '/' };

let suite: SuiteHandle | undefined;
/**
 * Stops the whole run naming `problem`: the launcher only ends a run for its own
 * SevereServiceError class, and logs any other hook error. The class is loaded at
 * run time because WebdriverIO's type declarations are not loaded (see driver.ts).
 */
async function stopRun(problem: string): Promise<never> {
  const name = 'webdriverio';
  const { SevereServiceError } = (await import(name)) as { SevereServiceError: new (message: string) => Error };
  throw new SevereServiceError(problem);
}
const adb: Adb = (args) => execFileSync(commandPath('adb', { dirs: ADB_DIRS }), args, { encoding: 'utf8' });
/** When each Android forward was last listed, and which workers run on Android (shyden-labs/shydesk#153). */
const forwardsSeen = new Map<number, Date>();
const androidWorkers = new Set<string>();
const counts = { passed: 0, failed: 0 };

export const config: Options.Testrunner & Capabilities.WithRequestedTestrunnerCapabilities = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  maxInstances: 1,
  capabilities: targets.map((target) => ({
    ...capabilitiesFor(target, targetEnv),
    ...appium,
    // A desktop-only spec file never runs on a phone (shyden-labs/shydesk#175).
    'wdio:exclude': otherGroupSpecs(),
  })),
  baseUrl: BASE,
  logLevel: 'warn',
  // A session that fails to start fails once, naming why: a retry is not a fix (shyden-labs/shydesk#49).
  connectionRetryCount: 0,
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 480_000 },
  reporters: ['spec'],

  /** Serves the suite's pages to each phone: the LAN address for the iPhone, adb reverse for Android. */
  async onPrepare() {
    rmSync(RUNS, { recursive: true, force: true });
    mkdirSync(RUNS);
    if (targets.includes('android')) {
      const serial = process.env.E2E_ANDROID_SERIAL ?? '';
      const problem = adbProblem(
        serial,
        () => setForwards(adb, serial, FORWARD_PORTS) ?? checkForwards(adb, serial, FORWARD_PORTS, forwardsSeen, new Date()),
      );
      if (problem !== undefined) await stopRun(problem);
    }
    suite = await startSuite({
      runsDir: RUNS,
      port: PORT,
      base: BASE,
      suiteOrigins: targets.map((target) => suiteOriginFor(target, BASE)),
    });
  },

  onWorkerStart(cid, capabilities) {
    if (targetOf(capabilities as Record<string, unknown>) === 'android') androidWorkers.add(cid);
  },

  /** A lost Android forward stops the run here, naming the port, not as a refused page in the next spec. */
  async onWorkerEnd(cid) {
    if (!androidWorkers.has(cid)) return;
    const serial = process.env.E2E_ANDROID_SERIAL ?? '';
    const problem = adbProblem(serial, () => checkForwards(adb, serial, FORWARD_PORTS, forwardsSeen, new Date()));
    if (problem !== undefined) await stopRun(problem);
  },

  /** Each target opens the suite where it reads it securely (shyden-labs/shydesk#21). */
  before(capabilities) {
    driver().options.baseUrl = suiteOriginFor(targetOf(capabilities as Record<string, unknown>), BASE);
  },

  async afterTest(test, _context, result) {
    counts[result.passed ? 'passed' : 'failed'] += 1;
    // A failure prints what the support piece showed, so its cause is in the log.
    if (!result.passed) console.log(`support piece after "${test.title}": ${await supportPieceState()}`);
    if (!result.passed) await savePhoneScreen(RUNS, test.title);
  },

  /** Each worker (one target, one spec file) records what it ran. */
  after(_result, capabilities) {
    const target = targetOf(capabilities as Record<string, unknown>);
    const run = { target, ...counts, skipped: 0 };
    writeFileSync(join(RUNS, `${target}-${process.env.WDIO_WORKER_ID ?? 'worker'}.json`), JSON.stringify(run));
  },

  async onComplete() {
    await suite?.stop();
  },
};
