# Design: ShyDesk's desktop e2e suite on Playwright (shyden-labs/shydesk#176, desktop half)

Date: 2026-11-25. Self-approved under the global rule "plans and specs are reviewed to zero, then
self-approved"; Shyden was asleep and had asked for work to carry on without him.

## Intent

Shyden ruled on 2026-11-17 that every project drops its own device runner and runs one suite through
the shared package `@shyden-labs/playwright-devices`, on phones and desktop browsers alike.
ShyDesk's e2e suite is WebdriverIO (`wdio.conf.ts`, `tests/e2e/*.e2e.ts`); the package drives
Playwright only (playwright-devices-e3, 2026-11-25). Version 0.1.5 on npm exports the desktop
browsers (`./desktop`) and the one-suite checks (`.`, the `one-suite` CLI, the
`./assertion-counter` reporter). The phone layer follows with shyden-labs/playwright-devices#54 (about
2026-11-27 to 11-28, a guess). This design covers shyden-labs/shydesk#176 AC2 and AC3, so the phones (AC1) only add
projects later.

## Goals

- Every e2e test runs as a Playwright test on `desktopProjects()`, which covers chromium, chrome,
  firefox, webkit and msedge, with equal totals, passing in CI (AC2).
- Every assertion of today's six tests is kept, on real input (AC2; global "one journey, all its
  assertions" and "every test is as real as its kind allows").
- ShyDesk's own totals and skip checks (`scripts/e2e-totals.ts`, `tests/unit/no-skips.test.ts` as it
  applies to e2e) give way to the package's `one-suite` checks for the desktop group (AC3).
- `@shyden-labs/playwright-devices` declared as `>=0.1.5` (global never-pin rule; the package's own
  README says `--save-exact`, the global rule wins).

## Non-goals

- Phones (AC1): they wait for shyden-labs/playwright-devices#54 and shyden-labs/playwright-devices#7. The WebdriverIO device runner
  (`test:e2e:device`, Appium, `targets.ts`' phone parts) stays until then, unused on desktop.
- Changing product behaviour. Only the colour work in shyden-labs/shydesk#299 changes the product,
  and it moves onto the Playwright suite after this port.

## Anti-goals

- An assertion dropped, weakened or turned into a soft pass.
- Synthetic input: `dispatchEvent`, setting `.value`, or scripted scrolling. Playwright's `click`,
  `keyboard`/`pressSequentially` and `mouse` send trusted input through the browser's own protocol,
  which is the same standing as WebDriver actions today.
- Retries: `retries: 0`, `forbidOnly: true`.
- A commit that leaves CI red.

## Constraints

- One run at a time on the laptop. Every e2e run is CI's (global rule); the laptop typechecks and
  lints only.
- Strict TDD for a port: the product already exists, so "red first" means each Playwright spec is
  committed with only stub harness functions that throw `not ported`. It is pushed to a draft PR,
  every new test is read failing by name on CI, and then the harness is written. Each ported test is
  also checked to fail on a broken product once (a scratch commit, for example the wrong status
  text), then put back.
- Every test is equal on every desktop target. A test for one group only needs a tag with a reason;
  none is expected.

## Approaches

1. **Side by side, one spec file per PR (chosen).** Add `playwright.config.ts` and
   `tests/e2e-pw/*.spec.ts`, plus a CI job `e2e-playwright` next to `e2e-desktop`. Port
   `harness.e2e.ts`, then `appeal.e2e.ts`, then `contact.e2e.ts` (the largest). Once all three pass
   on all five browsers, remove the WebdriverIO desktop job, `E2E_TARGETS` desktop routes, the
   Safari driver steps, and ShyDesk's e2e totals script. Each PR stays reviewable, and CI stays
   green throughout.
2. **Big-bang swap in one PR.** It ends in the same place, but a 2,700-line change can't keep every
   step green or be reviewed in one round. Rejected.
3. **Keep WebdriverIO and use only the package's checks.** The package reads Playwright's reports
   and drives Playwright only, so this can't meet AC1 or AC2. Rejected.

## How (builder's calls, stated)

- **Config.** `playwright.config.ts` sets `projects: desktopProjects()`, `workers: 1` (one local
  ShyDesk and its database, as today), `retries: 0`, `forbidOnly: true`, reporters `list`, `json`
  and the assertion counter. `globalSetup` reuses today's start-up: the local ShyDesk from
  `tests/e2e/harness/local-shydesk.ts`, the static demo pages server and the Access stand-in token
  from `wdio.conf.ts`. These move into a shared module both configs import until WebdriverIO goes.
- **Harness.** `tests/e2e-pw/harness/` is a thin set of fixtures:
  - Find by accessible name: `getByRole` or `getByLabel`. Playwright's role and label engines pierce
    open shadow roots, so this replaces `find.ts`' walker; measure on all five browsers in the first
    PR.
  - Type: a real click, then `pressSequentially`, and the field read back exactly, as today.
  - Pick a file: a real click on the input, then Playwright's `filechooser` event and `setFiles`.
    This replaces WebDriver's send-keys to the input, which is the same standing. Shyden's 2026-11-09
    ruling to drive the real macOS panel was for safaridriver. WebKit takes Safari's place under
    AC2, so that ruling has nothing left to apply to; it is recorded here so it is not lost.
  - Text waits: `expect(locator).toHaveText` / `toContainText` with a stated timeout, failing with
    the last text read (keeps shyden-labs/shydesk#294's behaviour).
  - Contrast: `contrast.ts`' pure functions are reused unchanged; only the colour read becomes
    `locator.evaluate`.
  - Desk sign-in: the Access stand-in cookie via `context.addCookies`.
- **CI.** The job runs on `ubuntu-latest` with `npx playwright install --with-deps chromium chrome
  firefox webkit msedge`, which is cheaper than macOS. WebKit there is Playwright's WebKit build, as
  AC2 names. If the local ShyDesk (`wrangler dev`) or a browser channel fails on Linux, fall back to
  `macos-26` and record why.
- **Checks.** After the run, `npx one-suite --group desktop=chromium,chrome,firefox,webkit,msedge
  --list <list.json> --report <report.json> --assertions <assertions.json>`. The list comes from
  `playwright test --list --reporter=json`. The job fails on any problem it prints.
- **Unit tests** for any pure helper moved or added (stays at the 100% coverage floor).

## Order of work (each its own PR into develop)

1. Config, global setup, CI job and `harness.spec.ts` (the input helpers' proof). Tests first, red on
   CI, then the harness.
2. `appeal.spec.ts`.
3. `contact.spec.ts`: all four tests, every assertion.
4. Remove the WebdriverIO desktop job and code; one-suite becomes the only desktop check (AC3). This
   PR is also the first proof of the 0.1.5 tarball, so report the result to playwright-devices-e3.

## Left to the builder

The file layout inside `tests/e2e-pw/`, fixture names, and where the shared start-up module lives.

## Parked for Shyden

Nothing is needed to start. If Linux CI cannot run the local ShyDesk, the fallback is macOS (a
builder call). A browser that cannot run a test is never skipped: it is named with its measurement
and goes to Shyden (AC4).
