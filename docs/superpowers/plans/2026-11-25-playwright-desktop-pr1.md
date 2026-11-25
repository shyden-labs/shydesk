# Playwright desktop suite, PR 1 (config, start-up, CI job, harness proof) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ShyDesk runs its first Playwright e2e test, the input-helper proof ported from
`tests/e2e/harness.e2e.ts`, on all five desktop browsers from `@shyden-labs/playwright-devices`, in
a CI job beside the WebdriverIO one.

**Architecture:** the WebdriverIO start-up (local ShyDesk under `wrangler dev`, demo pages server,
Access stand-in token) moves out of `wdio.conf.ts` into one module that both runners import.
`playwright.config.ts` uses it as `globalSetup`. Playwright tests live in `tests/e2e-pw/`, with a
small harness of real-input helpers taking a `Page`.

**Tech Stack:** `@playwright/test` (newest, exact pin), `@shyden-labs/playwright-devices` `>=0.1.5`,
TypeScript run by Node 26 type stripping as today, GitHub Actions `ubuntu-latest`.

**Spec:** `docs/superpowers/specs/2026-11-25-playwright-desktop-port-design.md`

## Global Constraints

- `retries: 0`, `forbidOnly: true`, `workers: 1`.
- `@shyden-labs/playwright-devices` is declared `>=0.1.5` and never pinned. `@playwright/test` is
  pinned exactly, at `^1.65.1` or newer, as the package's peer.
- Real input only: `locator.click()`, `locator.pressSequentially()`, the `filechooser` event with
  `setFiles`. Never `dispatchEvent`, `fill()`, `evaluate` to set values, or `setInputFiles` without
  a click.
- Every test is red on CI by name before its harness code exists (global TDD rule, 2026-11-22).
- The laptop runs only unit tests, typecheck, lint and format. Every e2e run is CI's.
- Refs as `shyden-labs/shydesk#176`, never a closing keyword.

## Review Focus

1. A browser that reports `isTrusted:false` for the file `change` event under `setFiles` (WebKit is
   the likeliest). The harness test asserts `file-change:true:<size>` on every browser, so it fails
   by name. Never weaken it. Name the browser and the measurement, and take it to Shyden (#176 AC4).
2. `chrome` or `msedge` channels not installable on `ubuntu-latest`. The install step fails naming
   the channel. Fall back to `macos-26` per the spec and record why in the job comment.
3. `wrangler dev` on Linux not answering `/health` within `SHYDESK_START_MS` (90 s). The global
   setup fails naming the log path, as WebdriverIO's start-up does today.
4. Port 8765 or 8787 already held on the runner. Start-up fails naming the port; it never waits
   forever.
5. The WebdriverIO desktop job breaking after the start-up moves. It keeps running in this PR and
   must stay green on the same head.

---

### Task 1: One start-up module for both runners

**Files:**
- Create: `tests/e2e/harness/suite-start.ts`
- Modify: `wdio.conf.ts` (onPrepare, onComplete, `startShydesk`, `accessStandIn`, the pages server)

**Interfaces:**
- Produces: `startSuite(options: { runsDir: string; port: number; base: string }): Promise<SuiteHandle>`
  where `SuiteHandle = { repToken: string; stop(): Promise<void> }`. It starts the local ShyDesk,
  serves `tests/e2e/pages` and the `DEMO_PAGES` map on `port`, and sets
  `process.env.E2E_REP_TOKEN`.

- [ ] **Step 1:** Move `startShydesk`, `accessStandIn`, the pages server, `DEMO_PAGES`, `TYPES` and
  `SHYDESK_START_MS` from `wdio.conf.ts` into `suite-start.ts` unchanged. Keep the phone-only
  steps (adb) in `wdio.conf.ts`.
- [ ] **Step 2:** In `wdio.conf.ts`, `onPrepare` calls `startSuite`, and `onComplete` calls
  `stop()`.
- [ ] **Step 3:** Run `npx tsc --noEmit` and `npx eslint wdio.conf.ts tests/e2e/harness/suite-start.ts`.
  Expected: exit 0. The WebdriverIO desktop CI job on this PR is the behaviour check: same totals
  as develop.

### Task 2: Config, CI job and the harness spec, red on CI

**Files:**
- Modify: `package.json` (dev dependencies; script
  `"test:e2e:pw": "playwright test --config playwright.config.ts"`), `package-lock.json`
- Create: `playwright.config.ts`, `tests/e2e-pw/global-setup.ts`, `tests/e2e-pw/harness/input.ts`
  (stubs), `tests/e2e-pw/harness.spec.ts`
- Modify: `.github/workflows/ci.yml` (new job `e2e-playwright`), `tsconfig.json` and
  `eslint.config.js` only if `tests/e2e-pw` is not already in their globs

**Interfaces:**
- Consumes: `startSuite` (Task 1).
- Produces, in `tests/e2e-pw/harness/input.ts`:
  - `tap(page: Page, label: string): Promise<void>`
  - `type(page: Page, label: string, text: string): Promise<void>`
  - `pickFile(page: Page, label: string, fixture: Fixture): Promise<void>`, with `Fixture` imported
    from `tests/e2e/harness/targets.ts`.
  In this task each one throws `new Error('not ported: <name>')`.

- [ ] **Step 1:** `npm install --save-dev --save-exact @playwright/test@latest`, then
  `npm install --save-dev @shyden-labs/playwright-devices@">=0.1.5"`. Confirm `package.json` reads
  `">=0.1.5"`. Run `npx vitest run --config vitest.unit.config.ts tests/unit/licences.test.ts
  tests/unit/supply-chain.test.ts`. Expected: PASS. A failure means a rule is breached: stop and
  read it.
- [ ] **Step 2:** In `playwright.config.ts`, set `testDir: 'tests/e2e-pw'`,
  `testMatch: '**/*.spec.ts'`, `projects: desktopProjects()`, `use.baseURL` from
  `process.env.E2E_ORIGIN ?? 'http://localhost:8765'`, the Global Constraints values,
  `globalSetup: './tests/e2e-pw/global-setup.ts'`, and the reporters `list`,
  `['json', { outputFile: '.e2e-runs/playwright-report.json' }]` and
  `['@shyden-labs/playwright-devices/assertion-counter', { outputFile: '.e2e-runs/assertions.json', unnamedTarget: 'desktop' }]`.
  `global-setup.ts` calls `startSuite` and returns its `stop`.
- [ ] **Step 3:** Write `harness.spec.ts` as one test, `test("reach the page as trusted clicks and
  key presses, and pick files whole through the target's own picker", ...)`, keeping every check
  of `harness.e2e.ts`:
  - `page.goto('/harness.html')`, then log `window-size`.
  - `tap` 'Harness button', then the events include `button-click:true`.
  - `type` 'Harness field' 'ok', then the events include `field-input:true:ok`, and the four
    entries ending there equal `['field-keydown:true:o','field-input:true:o','field-keydown:true:k','field-input:true:ok']`.
  - `pickFile` photo.jpg, then `file-change:true:<size>` and `file-read:<size>`. The same for
    ok-10s.mp4.

  `eventsHolding(page, expected)` uses `expect.poll` over the text of
  `getByRole('status', { name: 'Harness events' })` (an `<output>` has the status role), with a
  15 s timeout and the message `the page never logged "<expected>"; it logged "<events>"`. It
  writes `check-ran: <expected>` to stdout.
- [ ] **Step 4:** Add a CI job `e2e-playwright` to `.github/workflows/ci.yml` on `ubuntu-latest`,
  with the same checkout, Node from the Dockerfile and `node scripts/npm-ci.ts` steps as
  `e2e-desktop` (actions pinned to the same SHAs). Then
  `npx playwright install --with-deps chromium chrome firefox webkit msedge`, then
  `npm run test:e2e:pw`. Add it to the required checks list only in PR 4, when it replaces
  `e2e-desktop`.
- [ ] **Step 5:** Run `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` and the full
  unit suite with `npx vitest run --config vitest.unit.config.ts`. Read each exit code. Expected:
  all 0.
- [ ] **Step 6:** Commit tests, config, stubs and job together:
  `Tests: the input-helper proof on Playwright's five desktop browsers (Refs shyden-labs/shydesk#176)`.
  Push and open a draft PR into develop.
- [ ] **Step 7:** Read the `e2e-playwright` job's log. Expected: the test fails on each of the five
  projects, by name, with `not ported: tap`. Any other failure (install, start-up) is fixed first
  in a new commit, and the red is read again. Keep the run URL for the PR description.

### Task 3: Real-input helpers, green on all five

**Files:**
- Modify: `tests/e2e-pw/harness/input.ts`

**Interfaces:**
- Consumes and produces the Task 2 signatures, unchanged.

- [ ] **Step 1:** `tap`: `page.getByLabel(label, { exact: true })`, falling back to
  `getByRole(<any>, { name: label, exact: true })` only if the label finds nothing. It must resolve
  to exactly one element (Playwright's strict mode); then `.click()`.
- [ ] **Step 2:** `type`: read the field's value, `tap` it, `pressSequentially(text)`, then read it
  back. If it does not equal before + text, throw
  `"<label>" holds "<value>", not "<expected>"`, as `typedMismatch` words it today (reuse it from
  `tests/e2e/harness/input.ts` if it is exported, or move it into a shared module).
- [ ] **Step 3:** `pickFile`: `Promise.all([page.waitForEvent('filechooser'), tap(page, label)])`,
  then `chooser.setFiles(resolve(MEDIA, fixture))`, where `MEDIA` is `tests/fixtures/media`.
- [ ] **Step 4:** Run the typecheck and lint. Commit
  `The Playwright input helpers send real clicks, key presses and file choices (Refs shyden-labs/shydesk#176)`.
  Push.
- [ ] **Step 5:** Read the job. Expected: 1 passed on each of chromium, chrome, firefox, webkit and
  msedge (5 passed). For any browser that fails, apply Review Focus 1 to 3; never skip it.
- [ ] **Step 6:** Mutation check, once: in one commit, change `harness.html`'s
  `button-click:${event.isTrusted}` to log `false`. Push, read the red on all five, then revert in
  the next commit and push. Note both run URLs in the PR description.

### Task 4: One-suite check in the job

**Files:**
- Modify: `.github/workflows/ci.yml` (job `e2e-playwright`)

- [ ] **Step 1:** Before the run, add a step that lists the tests:
  `npx playwright test --config playwright.config.ts --list --reporter=json > .e2e-runs/playwright-list.json`.
- [ ] **Step 2:** After the run, add a step with `if: always()` (so a red run is still checked, and
  the step's own exit fails the job):
  `npx one-suite --group desktop=chromium,chrome,firefox,webkit,msedge --list .e2e-runs/playwright-list.json --report .e2e-runs/playwright-report.json --assertions .e2e-runs/assertions.json`.
- [ ] **Step 3:** Push. Expected: one total line per browser, each `1` test, and no problems. Then
  run CI's coverage job and every check green on the head SHA (read by name). Then mark the PR
  ready, merge it into develop (squash), clean up the branch and worktree, and tell
  playwright-devices-e3 that 0.1.5 installed and ran clean (or what failed).
