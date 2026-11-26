/**
 * The suite's input helpers reach a page as real input on every target
 * (shyden-labs/shydesk#42 AC4, on Playwright for shyden-labs/shydesk#176): a
 * trusted click, trusted key presses, and a file chosen through the browser's
 * own file chooser arriving whole.
 */
import { expect, test, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Fixture } from '../e2e/harness/targets.ts';
import { pickFile, tap, type } from './harness/input.ts';

const size = (fixture: Fixture): number => statSync(resolve(import.meta.dirname, '../fixtures/media', fixture)).size;

/**
 * Logs one check that ran and passed, so a CI run's output shows every check each target made
 * (shyden-labs/shydesk#130).
 */
function ran(check: string): void {
  process.stdout.write(`check-ran: ${check}\n`);
}

/** The page's event log once it holds `expected`, or a failure showing what it held. */
async function eventsHolding(page: Page, expected: string): Promise<string> {
  const log = page.getByRole('status', { name: 'Harness events' });
  let events = '';
  await expect
    .poll(
      async () => {
        events = (await log.textContent()) ?? '';
        return events.split(' ').includes(expected);
      },
      { timeout: 15_000, message: `the page never logged "${expected}"` },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(`the page never logged "${expected}"; it logged "${events}"`, { cause: error });
    });
  ran(expected);
  return events;
}

// One journey on one page load (shyden-labs/shydesk#130): every helper's checks, in the order a person would act.
test("the input helpers reach the page as trusted clicks and key presses, and pick files whole through the browser's own chooser", async ({
  page,
}) => {
  await page.goto('/harness.html');
  // Each target runs at its own window size; none is set by the suite (shyden-labs/shydesk#130).
  const windowSize = await page.evaluate('`${String(innerWidth)}x${String(innerHeight)}`');
  process.stdout.write(`window-size: ${String(windowSize)}\n`);
  await tap(page, 'Harness button');
  await eventsHolding(page, 'button-click:true');
  await type(page, 'Harness field', 'ok');
  const events = await eventsHolding(page, 'field-input:true:ok');
  // Each typed character's trusted keydown, then the input it made, in order; whatever the keyboard sends
  // after the last character does not change the check (shyden-labs/shydesk#145).
  process.stdout.write(`field-events: ${events}\n`);
  const logged = events.split(' ');
  const typed = logged.indexOf('field-input:true:ok');
  expect(logged.slice(typed - 3, typed + 1), events).toEqual([
    'field-keydown:true:o',
    'field-input:true:o',
    'field-keydown:true:k',
    'field-input:true:ok',
  ]);
  ran('field-keydown:true:o field-input:true:o field-keydown:true:k field-input:true:ok');
  await pickFile(page, 'Harness file', 'photo.jpg');
  await eventsHolding(page, `file-change:true:${String(size('photo.jpg'))}`);
  await eventsHolding(page, `file-read:${String(size('photo.jpg'))}`);
  await pickFile(page, 'Harness file', 'ok-10s.mp4');
  await eventsHolding(page, `file-change:true:${String(size('ok-10s.mp4'))}`);
  await eventsHolding(page, `file-read:${String(size('ok-10s.mp4'))}`);
});
