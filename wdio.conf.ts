/**
 * The one end-to-end suite, run unchanged on every target (shyden-labs/shydesk#42).
 *
 *   E2E_TARGETS=chromium,firefox,safari npm run test:e2e    (CI, macOS runner)
 *   E2E_TARGETS=android,ios E2E_ORIGIN=http://<this Mac's LAN address>:8765 \
 *     E2E_IOS_UDID=<udid> E2E_ANDROID_SERIAL=<serial> \
 *     E2E_CHROMEDRIVER=<chromedriver for the phone's Chrome> npm run test:e2e:device   (real phones over USB, Appium on 4723)
 *
 * Every target runs every spec file. Each worker writes its counts to
 * `.e2e-runs/`, and `scripts/e2e-totals.ts` prints the total per target and
 * fails naming any target that ran fewer tests.
 */
import type { Capabilities, Options } from '@wdio/types';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { capabilitiesFor, targetOf, targetsFrom, type Target, type TargetEnv } from './tests/e2e/harness/targets.ts';

const RUNS = '.e2e-runs';
const PAGES = 'tests/e2e/pages';
const PORT = 8765;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

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
const onPhone = (target: Target): boolean => target === 'android' || target === 'ios';

let server: Server | undefined;
const counts = { passed: 0, failed: 0 };

export const config: Options.Testrunner & Capabilities.WithRequestedTestrunnerCapabilities = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  maxInstances: 1,
  capabilities: targets.map((target) => ({
    ...capabilitiesFor(target, targetEnv),
    ...(onPhone(target) ? appium : {}),
  })),
  baseUrl: process.env.E2E_ORIGIN ?? `http://localhost:${String(PORT)}`,
  logLevel: 'warn',
  // A session that fails to start fails once, naming why: a retry is not a fix (shyden-labs/shydesk#49).
  connectionRetryCount: 0,
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  reporters: ['spec'],

  /** Serves the suite's pages to every target: localhost on desktop, the LAN address for the iPhone, adb reverse for Android. */
  onPrepare() {
    rmSync(RUNS, { recursive: true, force: true });
    mkdirSync(RUNS);
    server = createServer((request, response) => {
      // The server listens on the LAN for the iPhone, so nothing outside the pages folder is served.
      let path = '';
      try {
        path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)).replace(/^\/+/, '');
      } catch {
        // A malformed address is not a page.
      }
      if (path === '' || path.startsWith('..')) {
        response.writeHead(404).end();
        return;
      }
      readFile(join(PAGES, path)).then(
        (body) => response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body),
        () => response.writeHead(404).end(),
      );
    }).listen(PORT, '0.0.0.0');
  },

  afterTest(_test, _context, result) {
    counts[result.passed ? 'passed' : 'failed'] += 1;
  },

  /** Each worker (one target, one spec file) records what it ran. */
  after(_result, capabilities) {
    const target = targetOf(capabilities as Record<string, unknown>);
    const run = { target, ...counts, skipped: 0 };
    writeFileSync(join(RUNS, `${target}-${process.env.WDIO_WORKER_ID ?? 'worker'}.json`), JSON.stringify(run));
  },

  onComplete() {
    server?.close();
  },
};
