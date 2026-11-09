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
import { named } from './harness/find.ts';
import { pickFile, tap, tapToNewPage, type } from './harness/input.ts';
import { SEEDED_TICKET_TOKEN, SHYDESK_PORT } from './harness/local-shydesk.ts';

const WAIT = 20_000;

/** The text of the element named `label` once it holds `expected`, or a failure showing what it held. */
async function textHolding(label: string, expected: string, timeout = WAIT): Promise<string> {
  const element = await named(label);
  let text = '';
  await driver().waitUntil(
    async () => {
      text = await element.getText();
      return text.includes(expected);
    },
    { timeout, timeoutMsg: `"${label}" never held "${expected}"; it held "${text}"` },
  );
  return text;
}

/** The size in KB of each attached file, once two are attached. */
async function attachedTwo(): Promise<number[]> {
  const element = await named('Attachments');
  let sizes: number[] = [];
  await driver().waitUntil(
    async () => {
      sizes = [...(await element.getText()).matchAll(/attached, (\d+) KB/g)].map((m) => Number(m[1]));
      return sizes.length === 2;
    },
    { timeout: 150_000, timeoutMsg: 'two attachments never finished uploading' },
  );
  return sizes;
}

describe('the contact form', () => {
  it('sends a request typed and tapped in, and shows the private link', async () => {
    // Each browser's ticket is its own: they share one local database, and the desk opens a ticket by its subject.
    const subject = `The app will not open ${String(Date.now())}`;
    await driver().url('/contact.html?product=demo');
    await type('Email', 'e2e@example.com');
    await type('Subject', subject);
    await type('Message', 'It closes as soon as it starts.');
    await type('Device', 'Test phone');
    // Too long is refused before any upload; then a video and a photo go straight to ShyDesk.
    await pickFile('Photos and videos', 'long-45s.mp4');
    await textHolding('Attachments', 'Videos can be up to 30 seconds long.');
    await pickFile('Photos and videos', 'ok-10s.mp4');
    // The piece gives up on shrinking after two minutes and sends the original.
    await textHolding('Attachments', 'attached,', 150_000);
    await pickFile('Photos and videos', 'photo.jpg');
    const attached = await attachedTwo();
    // shyden-labs/shydesk#21: each is stored smaller than its fixture, the 10,586 KB video and the 3,011 KB photo.
    const [video = Infinity, photo = Infinity] = attached;
    assert.ok(video < 10586 && photo < 3011, `not stored smaller than the originals: ${attached.join(', ')} KB`);
    // The test site key passes by itself; the button is enabled once it has.
    await textHolding('Support status', 'Ready to send');
    await tap('Send');
    // The status first: if the request fails, its failure shows what the status line said.
    await textHolding('Support status', 'The email could not be sent. Keep this link to follow the request.');
    const link = await textHolding('Private link', '#t=');
    assert.match(link, /\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);

    // The private link opens the conversation, and a reply typed there joins it (shyden-labs/shydesk#23).
    await driver().url(link);
    await textHolding('Conversation', 'It closes as soon as it starts.');
    await type('Reply', 'It still closes.');
    await pickFile('Photos and videos', 'photo.jpg');
    await textHolding('Attachments', 'attached,');
    await tap('Send reply');
    await textHolding('Support status', 'Reply sent.');
    await textHolding('Conversation', 'It still closes.');
    await textHolding('Conversation', 'Attachment, ');
    // The preview of the reply's photo really came, through the token's header: after the first message's video and photo.
    const preview = await named('Attachment preview 3');
    await driver().waitUntil(async () => Number(await preview.getProperty('naturalWidth')) > 0, {
      timeout: WAIT,
      timeoutMsg: 'the third attachment preview never drew',
    });

    // A rep signs in, switches product, opens the ticket, sends a canned reply they edited (shyden-labs/shydesk#24).
    const desk = new URL(link);
    desk.port = String(SHYDESK_PORT);
    await driver().url(`${desk.origin}/health`);
    await driver().setCookies({ name: 'CF_Authorization', value: process.env.E2E_REP_TOKEN ?? '', path: '/' });
    await driver().url(`${desk.origin}/desk?product=demo-elsewhere`);
    // The badge counts this run's unanswered tickets, once its first request is back.
    const badge = await named('Unread tickets');
    await driver().waitUntil(async () => /^\d+$/.test(await badge.getText()), {
      timeout: WAIT,
      timeoutMsg: 'the unread badge never showed a count',
    });
    await tapToNewPage('Demo');
    await tapToNewPage(subject);
    await textHolding('Conversation', 'It still closes.');
    await tap('Thanks');
    await type('Your reply', ' We are on it.');
    await tapToNewPage('Send reply');
    await textHolding('Reply status', 'Reply saved');
    const answer = `Hello e2e@example.com, about ${subject}. We are on it.`;
    await textHolding('Conversation', answer);

    // The customer's page shows that reply.
    await driver().url(link);
    await textHolding('Conversation', answer);

    // An attachment past its keeping time says so (seeded: tests/e2e/harness/local-shydesk.ts).
    await driver().url(`/support/ticket?seeded#t=${SEEDED_TICKET_TOKEN}`);
    await textHolding('Conversation', 'Attachment removed after 30 days.');

    // A link nobody holds shows one plain line.
    await driver().url('/support/ticket?unknown#t=nobody-holds-this');
    await textHolding('Support status', 'This link is no longer valid.');
  });

  it('cannot load on a page whose origin the product does not allow', async () => {
    // A known product whose only allowed origin is elsewhere: the browser refuses the answer (no CORS header).
    await driver().url('/contact.html?product=demo-elsewhere');
    await textHolding('Support status', 'The support form could not load here.');
  });
});
