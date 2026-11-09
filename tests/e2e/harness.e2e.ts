/**
 * The suite's input helpers reach a page as real input on every target
 * (shyden-labs/shydesk#42 AC4): a trusted click, trusted key presses, and a
 * file chosen through the target's own picker arriving whole.
 */
import { describe, it, beforeEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { driver } from './harness/driver.ts';
import { named } from './harness/find.ts';
import { pickFile, tap, type } from './harness/input.ts';
import type { Fixture } from './harness/targets.ts';

const size = (fixture: Fixture): number => statSync(resolve(import.meta.dirname, '../fixtures/media', fixture)).size;

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
  return events;
}

describe('the input helpers', () => {
  beforeEach(async () => {
    await driver().url('/harness.html');
  });

  it('a tap reaches the page as a trusted click', async () => {
    await tap('Harness button');
    await eventsHolding('button-click:true');
  });

  it('typing reaches the field as trusted key presses', async () => {
    await type('Harness field', 'ok');
    const events = await eventsHolding('field-input:true:ok');
    assert.equal(events.split(' ').filter((event) => event === 'field-keydown:true').length, 2, events);
  });

  it("a photo picked through the target's own picker arrives whole", async () => {
    await pickFile('Harness file', 'photo.jpg');
    await eventsHolding(`file-change:true:${String(size('photo.jpg'))}`);
    await eventsHolding(`file-read:${String(size('photo.jpg'))}`);
  });

  it("a 10-second video picked through the target's own picker arrives whole", async () => {
    await pickFile('Harness file', 'ok-10s.mp4');
    await eventsHolding(`file-change:true:${String(size('ok-10s.mp4'))}`);
    await eventsHolding(`file-read:${String(size('ok-10s.mp4'))}`);
  });
});
