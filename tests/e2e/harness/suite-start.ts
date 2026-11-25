/**
 * What every e2e run needs before its first test, whichever runner drives it
 * (shyden-labs/shydesk#176): this branch's ShyDesk under `wrangler dev` with a
 * fresh local D1, the suite's pages and the demo pages on one port, and a
 * sign-in key for the rep. WebdriverIO's config and Playwright's global setup
 * both start the suite here, so the two runs test the same thing.
 */
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { NPX_CLI } from '../../../scripts/command-path.ts';
import {
  E2E_ACCESS_AUD,
  E2E_ACCESS_TEAM,
  E2E_REP,
  demoPage,
  pageStylePolicy,
  seedSql,
  shydeskOrigin,
  wranglerDevArgs,
} from './local-shydesk.ts';

const PAGES = 'tests/e2e/pages';
const DEMO_PAGES: Record<string, string> = {
  'contact.html': 'demo-host/public/index.html',
  'support/ticket': 'demo-host/public/support/ticket/index.html',
  'support/appeal': 'demo-host/public/support/appeal/index.html',
  'dark.html': 'demo-host/public/dark/index.html',
};
/** How long the local ShyDesk may take to answer /health before the run fails naming its log. */
const SHYDESK_START_MS = 90_000;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

export interface SuiteOptions {
  /** Where the run keeps its state, seed and logs; the caller creates it empty. */
  runsDir: string;
  /** The port the suite's pages are served on. */
  port: number;
  /** The suite's own origin, such as http://localhost:8765. */
  base: string;
  /** Every origin a target reads the suite from, each let in by the seeded products. */
  suiteOrigins: readonly string[];
}

export interface SuiteHandle {
  /** Stops the pages server and the local ShyDesk. */
  stop(): Promise<void>;
}

/**
 * A sign-in key for this run alone: the public half for the local ShyDesk, and a
 * signed token for the rep, handed to the tests in E2E_REP_TOKEN.
 */
async function accessStandIn(): Promise<string> {
  const pair = await generateKeyPair('RS256');
  process.env.E2E_REP_TOKEN = await new SignJWT({ email: E2E_REP })
    .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
    .setAudience(E2E_ACCESS_AUD)
    .setIssuer(`https://${E2E_ACCESS_TEAM}`)
    .setExpirationTime('6h')
    .sign(pair.privateKey);
  return JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'e2e', alg: 'RS256' }] });
}

/**
 * Starts this branch's ShyDesk under `wrangler dev` with a fresh local D1
 * (migrations, then the seed) and waits until /health answers, failing at
 * SHYDESK_START_MS naming the log.
 */
async function startShydesk({ runsDir, base, suiteOrigins }: SuiteOptions): Promise<ChildProcess> {
  const state = join(runsDir, 'shydesk-state');
  const shydesk = shydeskOrigin(base);
  const seed = join(runsDir, 'seed.sql');
  writeFileSync(seed, seedSql(base, suiteOrigins));
  const local = ['--local', '--persist-to', state];
  execFileSync(process.execPath, [NPX_CLI, 'wrangler', 'd1', 'migrations', 'apply', 'DB', ...local], { stdio: 'inherit' });
  execFileSync(process.execPath, [NPX_CLI, 'wrangler', 'd1', 'execute', 'DB', ...local, '--file', seed], { stdio: 'inherit' });
  const log = join(runsDir, 'shydesk.log');
  writeFileSync(log, '');
  const server = spawn(process.execPath, [NPX_CLI, ...wranglerDevArgs(state, await accessStandIn())], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk: Buffer) => {
    writeFileSync(log, chunk, { flag: 'a' });
  };
  server.stdout.on('data', append);
  server.stderr.on('data', append);
  const until = Date.now() + SHYDESK_START_MS;
  // Polling for the server to come up; each try starts the next, so no loop awaits (shyden-labs/shydesk#291).
  const answers = async (): Promise<boolean> => {
    if (Date.now() >= until || server.exitCode !== null) return false;
    const up = await fetch(`${shydesk}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return answers();
  };
  if (await answers()) return server;
  server.kill();
  throw new Error(
    `the local ShyDesk did not answer ${shydesk}/health within ${String(SHYDESK_START_MS / 1000)} s:\n${readFileSync(log, 'utf8').slice(-2000)}`,
  );
}

/** Serves the suite's pages, and each demo page pointed at the local ShyDesk, on `port`. */
function servePages(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    // The server listens on the LAN for the iPhone, so nothing outside the pages folder is served.
    let path = '';
    try {
      path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'https://x').pathname)).replace(/^\/+/, '');
    } catch {
      // A path that does not decode is not one of the suite's pages: it gets the 404 below.
    }
    const demo = DEMO_PAGES[path];
    if (demo !== undefined) {
      const product = new URL(request.url ?? '/', 'https://x').searchParams.get('product') ?? 'demo';
      try {
        const local = shydeskOrigin(`http://${request.headers.host ?? ''}`);
        const page = demoPage(readFileSync(demo, 'utf8'), local, product);
        response.writeHead(200, { 'content-type': TYPES['.html'], 'content-security-policy': pageStylePolicy(page) }).end(page);
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
  });
  // A held port fails the run naming it, never a wait (docs/superpowers/plans/2026-11-25-playwright-desktop-pr1.md).
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(new Error(`the suite's pages could not be served on port ${String(port)}: ${error.message}`));
    });
    server.listen(port, '0.0.0.0', () => {
      resolve(server);
    });
  });
}

/** Starts everything the suite needs, keeping its files in `runsDir`. */
export async function startSuite(options: SuiteOptions): Promise<SuiteHandle> {
  const shydesk = await startShydesk(options);
  const pages = await servePages(options.port).catch((error: unknown) => {
    shydesk.kill();
    throw error;
  });
  return {
    stop: () =>
      new Promise((resolve) => {
        shydesk.kill();
        pages.close(() => {
          resolve();
        });
      }),
  };
}
