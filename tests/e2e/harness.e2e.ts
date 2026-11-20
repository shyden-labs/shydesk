/**
 * The suite's input helpers reach a page as real input on every target
 * (shyden-labs/shydesk#42 AC4): a trusted click, trusted key presses, and a
 * file chosen through the target's own picker arriving whole.
 */
import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { driver } from './harness/driver.ts';
import { named } from './harness/find.ts';
import { openPage } from './harness/open-page.ts';
import { pickFile, tap, type } from './harness/input.ts';
import type { Fixture } from './harness/targets.ts';

const size = (fixture: Fixture): number => statSync(resolve(import.meta.dirname, '../fixtures/media', fixture)).size;

/**
 * Logs one check that ran and passed, so a CI run's output shows every check each target made
 * (shyden-labs/shydesk#130).
 */
function ran(check: string): void {
  process.stdout.write(`check-ran: ${check}\n`);
}

/** The page's event log once it holds `expected`, or a failure showing what it held. */
async function eventsHolding(expected: string): Promise<string> {
  let events = '';
  await driver().waitUntil(
    async () => {
      events = await (await named('Harness events')).getText();
      return events.split(' ').includes(expected);
    },
    { timeout: 15_000, timeoutMsg: `the page never logged "${expected}"; it logged "${events}"` },
  );
  ran(expected);
  return events;
}

// One journey on one page load (shyden-labs/shydesk#130): every helper's checks, in the order a person would act.
describe('the input helpers', () => {
  it("reach the page as trusted clicks and key presses, and pick files whole through the target's own picker", async () => {
    await openPage('/harness.html');
    // Each target runs at its own window size; none is set by the suite (shyden-labs/shydesk#130).
    const windowSize = await driver().execute<string>('return `${String(innerWidth)}x${String(innerHeight)}`;');
    process.stdout.write(`window-size: ${windowSize}\n`);
    await tap('Harness button');
    await eventsHolding('button-click:true');
    await type('Harness field', 'ok');
    const events = await eventsHolding('field-input:true:ok');
    // Each typed character's trusted keydown, then the input it made, in order; whatever the keyboard sends
    // after the last character does not change the check (shyden-labs/shydesk#145).
    process.stdout.write(`field-events: ${events}\n`);
    const logged = events.split(' ');
    const typed = logged.indexOf('field-input:true:ok');
    assert.deepEqual(
      logged.slice(typed - 3, typed + 1),
      ['field-keydown:true:o', 'field-input:true:o', 'field-keydown:true:k', 'field-input:true:ok'],
      events,
    );
    ran('field-keydown:true:o field-input:true:o field-keydown:true:k field-input:true:ok');
    await pickFile('Harness file', 'photo.jpg');
    await eventsHolding(`file-change:true:${String(size('photo.jpg'))}`);
    await eventsHolding(`file-read:${String(size('photo.jpg'))}`);
    await pickFile('Harness file', 'ok-10s.mp4');
    await eventsHolding(`file-change:true:${String(size('ok-10s.mp4'))}`);
    await eventsHolding(`file-read:${String(size('ok-10s.mp4'))}`);
  });
});
