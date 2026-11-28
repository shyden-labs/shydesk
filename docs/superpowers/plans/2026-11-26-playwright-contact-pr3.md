# Playwright desktop suite, PR 3 (contact.spec.ts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tests/e2e/contact.e2e.ts`'s four tests run on Playwright on all five desktop browsers,
every assertion kept (shyden-labs/shydesk#176 PR 3).

**Architecture:** port each WebdriverIO helper the spec uses to `tests/e2e-pw/harness/`, taking a
`Page`, reusing the pure functions in `tests/e2e/harness/{targets,contrast,video}.ts` unchanged.
One spec file, `tests/e2e-pw/contact.spec.ts`, test names identical to the WebdriverIO ones.

**Spec:** `docs/superpowers/specs/2026-11-25-playwright-desktop-port-design.md`, "Order of work" 3.

## Global Constraints

- Real input only: `locator.click()`, `pressSequentially`, `page.keyboard.press`, `page.mouse`
  (`move`/`down`/`up`/`wheel`), the `filechooser` event with `setFiles`. Never `dispatchEvent`,
  `fill`, `evaluate` to change state, or `setInputFiles` without a click.
- `evaluate` only reads (sizes, natural width, element at a point, video state).
- Every test red on CI by name before its helpers exist: stubs that reject `not ported`.
- `retries: 0`; no wait raised to hide slowness except the shrink wait the spec names (150 s), so
  the first test sets `test.setTimeout(300_000)`, stated in a comment.
- Refs `shyden-labs/shydesk#176`, never a closing keyword.

## Review Focus

1. WebKit's wheel delta: `zoomIn` asserts only "zoomed past 100%", as the WebdriverIO test does.
2. Firefox drag across the video (shyden-labs/shydesk#108 history): `swipeLeft` must start on the
   drag layer, never on the video's own controls; `pictureTakesPress` waits for it first.
3. `pressVideoControl` points come from `videoControlPoint(box, control, target)`: map Playwright
   project names to the existing targets (`chromium|chrome|msedge` → chromium rules, `firefox`,
   `webkit` → safari rules). A unit test pins the map.
4. `tapToNewPage`: Playwright's `page.waitForURL` after the click, never a fixed wait.
5. Playwright's WebKit is not Safari: on Linux it draws GTK media controls, so `SAFARI` control
   points (pause = picture middle; scrub 30 px up at 50%) may miss. Measure on the first green-path
   run (screenshot of the paused video attached); a miss goes to `videoControlPoint` as a new
   `webkit` target with its own unit test, never a skip.
6. `contrast.ts` and `video.ts` import only types and a lazy getter from `driver.ts` (unit tests
   already import them outside WebdriverIO), so the Playwright helpers import their pure functions
   directly; `LIST_PARTS` gets `export`. Moving them waits for PR 4, when WebdriverIO goes.
7. Cookie for the desk: `context.addCookies` with `url` = desk origin, as appeal.spec.ts does.

---

### Task 1: The four tests, red by name on CI

- [ ] Write `tests/e2e-pw/contact.spec.ts` (all four tests, every assertion, comments kept) and
      `tests/e2e-pw/harness/journey.ts` stubs rejecting `not ported: <helper>` (written).
- [ ] Unit: `tests/unit/e2e-pw-targets.test.ts` pins `targetForProject(name: string): Target`
      (chromium, chrome, msedge → 'chromium'; firefox → 'firefox'; webkit → 'safari'; other → throws).
      Red, then implement in `tests/e2e-pw/harness/targets.ts`.
- [ ] Full unit + coverage; push; draft PR; read e2e-playwright: 4 tests × 5 browsers fail
      `not ported` by name; harness and appeal still pass.

### Task 2: Helpers, green on all five

- [ ] `press(page, key)`, `zoomIn(page, label)` (mouse.wheel over the element's middle),
      `swipeLeft(page, label)` (mouse down at 75% width, move in 10 steps to 25%, up),
      `clickMiddleOf`, `pressVideoControl(page, label, control, target)`,
      `tapToNewPage(page, label)`, `pictureDrew`, `viewerClosed`, `zoomedIn`,
      `ownControlsUncovered`, `pictureTakesPress`, `untilVideo`/`watchVideo` (reads via
      `locator.evaluate`), `readable`/`everyPartReadable` (contrast.ts pure functions, colours read
      with `evaluate`), `attachedTwo`.
- [ ] Push; read e2e-playwright green: 6 tests per browser (harness 1, appeal 1, contact 4),
      equal totals printed by one-suite; WebdriverIO e2e-desktop still green.
- [ ] Mutation once: break `swipeLeft`'s direction; see the viewer test red; revert in the same call.
- [ ] Merge; evidence on shyden-labs/shydesk#176.
