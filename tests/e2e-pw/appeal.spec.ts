/**
 * The appeal view in the shared piece (shyden-labs/shydesk#61 AC4), on the demo appeal page
 * (demo-host/public/support/appeal/index.html) as a ban notice link opens it:
 * `#appeal=<token>`. Each browser appeals its own seeded punishment
 * (tests/e2e/harness/local-shydesk.ts), as every browser runs against one local ShyDesk.
 * There is no mail login, so the page says to keep the link. On Playwright for
 * shyden-labs/shydesk#176.
 */
import { expect, test } from '@playwright/test';
import { seededAppealToken, SHYDESK_PORT } from '../e2e/harness/local-shydesk.ts';
import { tap, type } from './harness/input.ts';
import { textHolding, touchSized } from './harness/read.ts';

test.describe('the appeal view', () => {
  test('takes one appeal typed and tapped in, shows its private link, and refuses a second', async ({ page, context }, testInfo) => {
    const token = seededAppealToken(testInfo.project.name);
    const words = `Please look again ${String(Date.now())}.`;
    await page.goto(`/support/appeal?first#appeal=${token}`);
    await textHolding(page, 'Decision', 'Ban 7 days');
    await touchSized(page, ['Email', 'Message', 'Send appeal']);
    await type(page, 'Email', 'appellant@example.com');
    await type(page, 'Message', words);
    await tap(page, 'Send appeal');
    // The status first: if the appeal fails, its failure shows what the status line said.
    await textHolding(page, 'Support status', 'The email could not be sent. Keep this link to follow the request.');
    const link = await textHolding(page, 'Private link', '#t=');
    expect(link).toMatch(/\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);

    // The same link again: one appeal per decision.
    await page.goto(`/support/appeal?second#appeal=${token}`);
    await textHolding(page, 'Decision', 'Ban 7 days');
    await textHolding(page, 'Support status', 'An appeal for this decision was already sent.');

    // The private link opens the appeal's conversation.
    await page.goto(link);
    await textHolding(page, 'Conversation', words);

    // A link nobody holds shows one plain line.
    await page.goto('/support/appeal?unknown#appeal=nobody-holds-this');
    await textHolding(page, 'Support status', 'This link is no longer valid.');

    // A rep's desk never shows the appeal (shyden-labs/shydesk#61 AC2): the list loads, with no appeal in it.
    const desk = new URL(link);
    desk.port = String(SHYDESK_PORT);
    await context.addCookies([{ name: 'CF_Authorization', value: process.env.E2E_REP_TOKEN ?? '', url: desk.origin }]);
    await page.goto(`${desk.origin}/desk?product=demo`);
    await textHolding(page, 'Ticket list', 'Cheating: player p-2');
    const listed = await textHolding(page, 'Ticket list', '');
    expect(listed, `the rep's desk listed an appeal: ${listed}`).not.toContain('Appeal');
  });
});
