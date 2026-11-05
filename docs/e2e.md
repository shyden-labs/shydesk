# End-to-end suite

One WebdriverIO suite, `tests/e2e/**/*.e2e.ts`, runs unchanged on every target
(shyden-labs/shydesk#42): desktop Chrome, Firefox and Safari in CI, and a real
Android phone (Chrome) and a real iPhone (Safari) over USB. Nothing is skipped
on any target; `tests/unit/no-skips.test.ts` fails on any skip, focus or filter.

Tests act only through `tests/e2e/harness/input.ts` (`tap`, `type`, `pickFile`),
which finds controls by their accessible name, so every control a test touches
needs one. On the phones the helpers use Appium's native layer: a real touch, real
key presses and the phone's own photo picker.

Each run prints the total per target and fails naming any target that ran fewer
tests (`scripts/e2e-totals.ts`).

## Desktop (CI)

The `e2e-desktop` job in `.github/workflows/ci.yml` runs
`E2E_TARGETS=chromium,firefox,safari npm run test:e2e` on macOS.

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
adb reverse tcp:8765 tcp:8765
E2E_TARGETS=android,ios E2E_ORIGIN=http://<this Mac's LAN address>:8765 \
  E2E_CHROMEDRIVER=<path> npm run test:e2e
```

The suite serves its pages on port 8765; the iPhone reaches them over the LAN,
Android through `adb reverse`.
