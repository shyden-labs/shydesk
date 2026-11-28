# End-to-end suite

The same journeys run on two runners until the phones move to the shared device
layer (shyden-labs/shydesk#176, waiting on shyden-labs/playwright-devices#68):

- Desktop: the Playwright suite, `tests/e2e-pw/*.spec.ts`, on every desktop
  browser `@shyden-labs/playwright-devices` gives: Chromium, Chrome, Firefox,
  WebKit and Edge, in CI.
- Phones: the WebdriverIO suite, `tests/e2e/**/*.e2e.ts`, on a real Android
  phone (Chrome) and a real iPhone (Safari) over USB.

Nothing is skipped on any target; `tests/unit/no-skips.test.ts` fails on any
skip, focus or filter.

Phone tests act only through `tests/e2e/harness/input.ts` (`tap`, `type`,
`pickFile`), which finds controls by their accessible name, so every control a
test touches needs one. The helpers use Appium's native layer: a real touch,
real key presses and the phone's own photo picker.

Before any target starts, the suite runs this branch's ShyDesk locally
(`wrangler dev` on port 8787, a fresh local D1 with the migrations and a seed,
Cloudflare's always-pass Turnstile test keys; `tests/e2e/harness/local-shydesk.ts`),
so a pull request tests its own code. `/contact.html` serves the demo support
page (`demo-host/public/index.html`) with its piece loaded from that ShyDesk;
`?product=demo-elsewhere` names a product allowed only on another origin. The
local ShyDesk's log is `.e2e-runs/shydesk.log`.

Each phone run prints the total per phone and the suite's count (read from the
spec files), and fails naming any phone that ran fewer tests than another or
than the whole suite (`scripts/e2e-totals.ts`).

Phones and desktop browsers are two groups. Within each group, every target runs
the identical set. A WebdriverIO spec named `<name>.desktop.e2e.ts` (first line
`// desktop-only: <why>`) never runs on a phone (shyden-labs/shydesk#175).

## Desktop (CI)

The `e2e-playwright` job in `.github/workflows/ci.yml` runs
`npm run test:e2e:pw` (`playwright.config.ts`) on Linux, starting the same
local ShyDesk first (`tests/e2e-pw/global-setup.ts`). Tests act only through
`tests/e2e-pw/harness/`: real mouse presses, key presses and the browser's own
file chooser. After the run, the shared package's `one-suite` check fails
unless every browser ran the same tests and the same assertions.

## Phones

One-time set-up:

- Appium 3 with the `xcuitest` and `uiautomator2` drivers, started with
  `ANDROID_HOME` set: `appium --port 4723`.
- Android: copy the test files into their own folder and index them:
  `adb push tests/fixtures/media/. /sdcard/DCIM/ShyDeskTests/`, then a media scan
  for each file. The picker's From this device > ShyDeskTests then shows only them.
- iPhone: AirDrop the three files in `tests/fixtures/media/` and put them in a
  Photos album named `ShyDesk tests`.
- Android needs a chromedriver matching the phone's Chrome, passed as
  `E2E_CHROMEDRIVER`.

Each run, with the phones unlocked and auto-lock off:

```sh
E2E_TARGETS=android,ios E2E_ORIGIN=http://<this Mac's LAN address>:8765 \
  E2E_IOS_UDID=<xcrun xctrace list devices> E2E_ANDROID_SERIAL=<adb devices> \
  E2E_CHROMEDRIVER=<path> npm run test:e2e:device
```

Real-device runs are the only suite run on a laptop; every other suite is CI's.

The suite serves its pages on port 8765 and the local ShyDesk on 8787; the
iPhone reaches both over the LAN, Android through `adb reverse` on localhost.
Android must read localhost: Chrome keeps WebCodecs, and so video shrinking,
from an insecure page, and a LAN http address is one (shyden-labs/shydesk#21).
The run sets both forwards on `E2E_ANDROID_SERIAL` itself before any session
starts, and stops at once naming a port adb does not then list. After each
Android spec it lists them again: a lost forward stops the run naming the port
and when it was last seen (shyden-labs/shydesk#153), instead of a connection
refused in a later spec.
