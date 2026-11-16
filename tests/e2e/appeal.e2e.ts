/**
 * The appeal view in the shared piece (shyden-labs/shydesk#61 AC4), on the demo
 * appeal page (demo-host/public/support/appeal/index.html) as a ban notice link
 * opens it: `#appeal=<token>`. Each target appeals its own seeded punishment
 * (tests/e2e/harness/local-shydesk.ts), as every target runs against one local
 * ShyDesk. There is no mail login, so the page says to keep the link.
 */
import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { driver } from './harness/driver.ts';
import { textHolding } from './harness/find.ts';
import { tap, type } from './harness/input.ts';
import { seededAppealToken, SHYDESK_PORT } from './harness/local-shydesk.ts';
import { openPage } from './harness/open-page.ts';
import { targetOf } from './harness/targets.ts';

describe('the appeal view', () => {
  it('takes one appeal typed and tapped in, shows its private link, and refuses a second', async () => {
    const token = seededAppealToken(targetOf(driver().capabilities));
    const words = `Please look again ${String(Date.now())}.`;
    await openPage(`/support/appeal?first#appeal=${token}`);
    await textHolding('Decision', 'Ban 7 days');
    await type('Email', 'appellant@example.com');
    await type('Message', words);
    await tap('Send appeal');
    // The status first: if the appeal fails, its failure shows what the status line said.
    await textHolding('Support status', 'The email could not be sent. Keep this link to follow the request.');
    const link = await textHolding('Private link', '#t=');
    assert.match(link, /\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);

    // The same link again: one appeal per decision.
    await openPage(`/support/appeal?second#appeal=${token}`);
    await textHolding('Decision', 'Ban 7 days');
    await textHolding('Support status', 'An appeal for this decision was already sent.');

    // The private link opens the appeal's conversation.
    await openPage(link);
    await textHolding('Conversation', words);

    // A link nobody holds shows one plain line.
    await openPage('/support/appeal?unknown#appeal=nobody-holds-this');
    await textHolding('Support status', 'This link is no longer valid.');

    // A rep's desk never shows the appeal (shyden-labs/shydesk#61 AC2): the list loads, with no appeal in it.
    const desk = new URL(link);
    desk.port = String(SHYDESK_PORT);
    await openPage(`${desk.origin}/health`);
    await driver().setCookies({ name: 'CF_Authorization', value: process.env.E2E_REP_TOKEN ?? '', path: '/' });
    await openPage(`${desk.origin}/desk?product=demo`);
    await textHolding('Tickets', 'Cheating: player p-2');
    const listed = await textHolding('Tickets', '');
    assert.ok(!listed.includes('Appeal'), `the rep's desk listed an appeal: ${listed}`);
  });
});
