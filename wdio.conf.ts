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
 *
 * Before any target starts, a local ShyDesk runs this branch's Worker on port
 * 8787 (tests/e2e/harness/local-shydesk.ts), and /contact.html serves the demo
 * page with its piece loaded from it (shyden-labs/shydesk#19).
 */
import type { Capabilities, Options } from '@wdio/types';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { demoPage, seedSql, shydeskOrigin, wranglerDevArgs } from './tests/e2e/harness/local-shydesk.ts';
import { capabilitiesFor, targetOf, targetsFrom, type Target, type TargetEnv } from './tests/e2e/harness/targets.ts';
import { savePhoneScreen, supportPieceState } from './tests/e2e/harness/report.ts';

const RUNS = '.e2e-runs';
const PAGES = 'tests/e2e/pages';
const PORT = 8765;
const BASE = process.env.E2E_ORIGIN ?? `http://localhost:${String(PORT)}`;
const SHYDESK = shydeskOrigin(BASE);
const STATE = join(RUNS, 'shydesk-state');
const DEMO_PAGE = 'demo-host/public/index.html';
/** How long the local ShyDesk may take to answer /health before the run fails naming its log. */
const SHYDESK_START_MS = 90_000;
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
let shydesk: ChildProcess | undefined;
const counts = { passed: 0, failed: 0 };

export const config: Options.Testrunner & Capabilities.WithRequestedTestrunnerCapabilities = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  maxInstances: 1,
  capabilities: targets.map((target) => ({
    ...capabilitiesFor(target, targetEnv),
    ...(onPhone(target) ? appium : {}),
  })),
  baseUrl: BASE,
  logLevel: 'warn',
  // A session that fails to start fails once, naming why: a retry is not a fix (shyden-labs/shydesk#49).
  connectionRetryCount: 0,
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  reporters: ['spec'],

  /** Serves the suite's pages to every target: localhost on desktop, the LAN address for the iPhone, adb reverse for Android. */
  async onPrepare() {
    rmSync(RUNS, { recursive: true, force: true });
    mkdirSync(RUNS);
    await startShydesk();
    server = createServer((request, response) => {
      // The server listens on the LAN for the iPhone, so nothing outside the pages folder is served.
      let path = '';
      try {
        path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)).replace(/^\/+/, '');
      } catch {
        // A malformed address is not a page.
      }
      if (path === 'contact.html') {
        const product = new URL(request.url ?? '/', 'http://x').searchParams.get('product') ?? 'demo';
        try {
          const page = demoPage(readFileSync(DEMO_PAGE, 'utf8'), SHYDESK, product);
          response.writeHead(200, { 'content-type': TYPES['.html'] }).end(page);
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/plain' }).end((error as Error).message);
        }
        return;
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

  onComplete() {
    server?.close();
    shydesk?.kill();
  },
};

/**
 * Starts this branch's ShyDesk under `wrangler dev` with a fresh local D1
 * (migrations, then the seed) and waits until /health answers, failing at
 * SHYDESK_START_MS naming the log.
 */
async function startShydesk(): Promise<void> {
  const seed = join(RUNS, 'seed.sql');
  writeFileSync(seed, seedSql(BASE));
  const local = ['--local', '--persist-to', STATE];
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', ...local], { stdio: 'inherit' });
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', ...local, '--file', seed], { stdio: 'inherit' });
  const log = join(RUNS, 'shydesk.log');
  writeFileSync(log, '');
  shydesk = spawn('npx', wranglerDevArgs(STATE), { stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (chunk: Buffer) => {
    writeFileSync(log, chunk, { flag: 'a' });
  };
  shydesk.stdout?.on('data', append);
  shydesk.stderr?.on('data', append);
  const until = Date.now() + SHYDESK_START_MS;
  while (Date.now() < until) {
    if (shydesk.exitCode !== null) break;
    const up = await fetch(`${SHYDESK}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  shydesk.kill();
  throw new Error(
    `the local ShyDesk did not answer ${SHYDESK}/health within ${String(SHYDESK_START_MS / 1000)} s:\n${readFileSync(log, 'utf8').slice(-2000)}`,
  );
}
