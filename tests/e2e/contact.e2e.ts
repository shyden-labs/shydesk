/**
 * The contact form in the shared piece, embedded on a product's support page
 * exactly as docs/embedding.md says (shyden-labs/shydesk#19 AC5). The page is
 * the demo page (demo-host/public/index.html) served on the suite's own
 * origin; the piece is loaded from a local ShyDesk running this branch's code
 * (wdio.conf.ts), with Cloudflare's always-pass Turnstile test keys and no
 * mail login, so the notice email fails and the page says to keep the link.
 */
import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { driver } from './harness/driver.ts';
import { tap, type } from './harness/input.ts';

const WAIT = 20_000;

/** The text of the element named `label` once it holds `expected`, or a failure showing what it held. */
async function textHolding(label: string, expected: string): Promise<string> {
  let text = '';
  await driver().waitUntil(
    async () => {
      const element = driver().$(`aria/${label}`);
      text = await element.getText().catch(() => '');
      return text.includes(expected);
    },
    { timeout: WAIT, timeoutMsg: `"${label}" never held "${expected}"; it held "${text}"` },
  );
  return text;
}

describe('the contact form', () => {
  it('sends a request typed and tapped in, and shows the private link', async () => {
    await driver().url('/contact.html?product=demo');
    await type('Email', 'e2e@example.com');
    await type('Subject', 'The app will not open');
    await type('Message', 'It closes as soon as it starts.');
    await type('Device', 'Test phone');
    // The test site key passes by itself; the button is enabled once it has.
    await textHolding('Support status', 'Ready to send');
    await tap('Send');
    const link = await textHolding('Private link', '#t=');
    assert.match(link, /\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);
    await textHolding('Support status', 'The email could not be sent. Keep this link to follow the request.');
  });

  it('cannot load on a page whose origin the product does not allow', async () => {
    // A known product whose only allowed origin is elsewhere: the browser refuses the answer (no CORS header).
    await driver().url('/contact.html?product=demo-elsewhere');
    await textHolding('Support status', 'The support form could not load here.');
  });
});
