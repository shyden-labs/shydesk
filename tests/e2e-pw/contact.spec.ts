/**
 * The contact form in the shared piece, embedded on a product's support page exactly as
 * docs/embedding.md says (shyden-labs/shydesk#19 AC5). The page is the demo page
 * (demo-host/public/index.html) served on the suite's own origin; the piece is loaded from a local
 * ShyDesk running this branch's code (tests/e2e-pw/global-setup.ts), with Cloudflare's always-pass
 * Turnstile test keys and no mail login, so the notice email fails and the page says to keep the
 * link. On Playwright for shyden-labs/shydesk#176.
 */
import { expect, test, type BrowserContext } from '@playwright/test';
import { SEEDED_TICKET_TOKEN, SHYDESK_PORT } from '../e2e/harness/local-shydesk.ts';
import { playing, sizeKnown } from '../e2e/harness/video.ts';
import { pickFile, tap, type } from './harness/input.ts';
import {
  attachedTwo,
  clickMiddleOf,
  everyPartReadable,
  ownControlsUncovered,
  pictureDrew,
  pictureTakesPress,
  press,
  pressVideoControl,
  previewDrew,
  readable,
  sendEnabled,
  swipeLeft,
  tapToNewPage,
  unreadCounted,
  untilVideo,
  viewerClosed,
  watchVideo,
  zoomedIn,
  zoomIn,
} from './harness/journey.ts';
import { textHolding, touchSized } from './harness/read.ts';

/** The desk's origin for a private link, signed in as the rep with the Access stand-in. */
async function deskFor(context: BrowserContext, link: string): Promise<string> {
  const desk = new URL(link);
  desk.port = String(SHYDESK_PORT);
  await context.addCookies([{ name: 'CF_Authorization', value: process.env.E2E_REP_TOKEN ?? '', url: desk.origin }]);
  return desk.origin;
}

test.describe('the contact form', () => {
  test('sends a request typed and tapped in, and shows the private link', async ({ page, context }) => {
    // The piece gives up on shrinking a video after two minutes (below), so this journey needs more than the default.
    test.setTimeout(300_000);
    // Each browser's ticket is its own: they share one local database, and the desk opens a ticket by its subject.
    const subject = `The app will not open ${String(Date.now())}`;
    await page.goto('/contact.html?product=demo');
    // Every control on the form takes a fingertip (shyden-labs/shydesk#256).
    await touchSized(page, ['Email', 'Subject', 'Category', 'Message', 'Device', 'Photos and videos', 'Send']);
    await type(page, 'Email', 'e2e');
    await type(page, 'Subject', subject);
    await type(page, 'Message', 'It closes as soon as it starts.');
    await type(page, 'Device', 'Test phone');
    // What is typed reads clearly on its field, and the category arrow shows (shyden-labs/shydesk#282).
    await readable(page, ['Email', 'Subject', 'Category', 'Message', 'Device']);
    // A refused send keeps saying why after the check hands over a new token, until the form changes
    // (shyden-labs/shydesk#242).
    await textHolding(page, 'Support status', 'Ready to send');
    await tap(page, 'Send');
    await textHolding(page, 'Support status', 'Check the fields marked below.');
    await sendEnabled(page, 'Send');
    await textHolding(page, 'Support status', 'Check the fields marked below.', 5_000);
    // Every label, status, error, button and field border reads on the light page (shyden-labs/shydesk#299).
    await everyPartReadable(page);
    await type(page, 'Email', '@example.com');
    await textHolding(page, 'Support status', 'Ready to send');
    // Too long is refused before any upload; then a video and a photo go straight to ShyDesk.
    await pickFile(page, 'Photos and videos', 'long-45s.mp4');
    await textHolding(page, 'Attachments', 'Videos can be up to 30 seconds long.');
    await pickFile(page, 'Photos and videos', 'ok-10s.mp4');
    // The piece gives up on shrinking after two minutes and sends the original.
    await textHolding(page, 'Attachments', 'attached,', 150_000);
    await pickFile(page, 'Photos and videos', 'photo.jpg');
    const attached = await attachedTwo(page);
    // shyden-labs/shydesk#21: each is stored smaller than its fixture, the 11,079 KB 2560×1440 video and the 3,011 KB photo.
    const [video = Infinity, photo = Infinity] = attached;
    expect(video < 11079 && photo < 3011, `not stored smaller than the originals: ${attached.join(', ')} KB`).toBe(true);
    // The test site key passes by itself; the button is enabled once it has.
    await textHolding(page, 'Support status', 'Ready to send');
    await tap(page, 'Send');
    // The status first: if the request fails, its failure shows what the status line said.
    await textHolding(page, 'Support status', 'The email could not be sent. Keep this link to follow the request.');
    const link = await textHolding(page, 'Private link', '#t=');
    expect(link).toMatch(/\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);
    // The private link and the status beside it read on the light page too (shyden-labs/shydesk#299).
    await everyPartReadable(page);

    // The private link opens the conversation, and a reply typed there joins it (shyden-labs/shydesk#23).
    await page.goto(link);
    await textHolding(page, 'Conversation', 'It closes as soon as it starts.');
    await touchSized(page, ['Reply', 'Photos and videos', 'Send reply']);
    await type(page, 'Reply', 'It still closes.');
    await pickFile(page, 'Photos and videos', 'photo.jpg');
    await textHolding(page, 'Attachments', 'attached,');
    await tap(page, 'Send reply');
    await textHolding(page, 'Support status', 'Reply sent.');
    await textHolding(page, 'Conversation', 'It still closes.');
    await textHolding(page, 'Conversation', 'Attachment, ');
    // The preview of the reply's photo really came, through the token's header: after the first message's video and photo.
    // Found by its button's name, which every target gives it (shyden-labs/shydesk#144).
    await previewDrew(page, 'Open photo 3');

    // The read-only viewer (shyden-labs/shydesk#25 AC3): a real wheel zooms, keys rotate and move on, a sideways drag
    // moves on again, the buttons zoom and rotate, and Esc closes it. Its three files: the video, the photo, the reply's photo.
    await tap(page, 'Open photo 3');
    await textHolding(page, 'Viewer status', 'Photo 3 of 3, zoom 100%, rotated 0°');
    await pictureDrew(page, 'Photo 3 full size');
    // How far one notch zooms depends on the wheel travel each browser reports, so only that it zoomed in is checked.
    await zoomIn(page, 'Viewer stage');
    await zoomedIn(page);
    await press(page, 'r');
    await press(page, 'r');
    await textHolding(page, 'Viewer status', 'rotated 180°');
    await textHolding(page, 'Viewer status', 'Photo 3 of 3, zoom ');
    await press(page, 'ArrowRight');
    await textHolding(page, 'Viewer status', 'Video 1 of 3, zoom 100%, rotated 0°');
    // shyden-labs/shydesk#108: a click on the video's picture plays it, and the browser's own controls,
    // along the bottom and the top of the picture, are left uncovered for the browser's pause and scrub.
    // What happens to the play is recorded, so a play Safari aborts names what aborted it (shyden-labs/shydesk#188).
    await watchVideo(page, 'Video 1 full size');
    // shyden-labs/shydesk#88: the 2560×1440 video was stored at no more than 1920×1080, on every browser.
    // The size is read once the metadata has loaded, never before (shyden-labs/shydesk#188).
    const shown = await untilVideo(page, 'Video 1 full size', sizeKnown, 'the video never reported its size');
    expect(`${String(shown.width)}×${String(shown.height)}`, 'the stored video size').toBe('1920×1080');
    await pictureTakesPress(page, 'Video 1 full size');
    await clickMiddleOf(page, 'Video 1 full size');
    await untilVideo(page, 'Video 1 full size', playing, 'the video never started playing');
    await ownControlsUncovered(page, 'Video 1 full size');
    await pressVideoControl(page, 'Video 1 full size', 'pause');
    await untilVideo(page, 'Video 1 full size', (v) => v.paused, "the browser's own pause never paused the video");
    await pressVideoControl(page, 'Video 1 full size', 'scrub');
    await untilVideo(
      page,
      'Video 1 full size',
      (v) => v.paused && v.currentTime >= 3,
      "the browser's own scrub bar never moved the 10 s video past 3 s",
    );
    await swipeLeft(page, 'Viewer stage');
    await textHolding(page, 'Viewer status', 'Photo 2 of 3, zoom 100%, rotated 0°');
    await pictureDrew(page, 'Photo 2 full size');
    await swipeLeft(page, 'Viewer stage');
    await textHolding(page, 'Viewer status', 'Photo 3 of 3, zoom 100%, rotated 0°');
    await tap(page, 'Zoom in');
    await tap(page, 'Rotate left');
    await textHolding(page, 'Viewer status', 'Photo 3 of 3, zoom 125%, rotated 270°');
    await press(page, 'ArrowLeft');
    await textHolding(page, 'Viewer status', 'Photo 2 of 3, zoom 100%, rotated 0°');
    await press(page, 'Escape');
    await viewerClosed(page);

    const desk = await deskFor(context, link);
    await page.goto(`${desk}/desk?product=demo-elsewhere`);
    await unreadCounted(page);
    await tapToNewPage(page, 'Demo');
    await tapToNewPage(page, subject);
    await textHolding(page, 'Conversation', 'It still closes.');
    await tap(page, 'Open photo 3');
    await textHolding(page, 'Viewer status', 'Photo 3 of 3, zoom 100%, rotated 0°');
    await pictureDrew(page, 'Photo 3 full size');
    await press(page, 'Escape');
    await viewerClosed(page);
    await tap(page, 'Thanks');
    await type(page, 'Your reply', ' We are on it.');
    await tapToNewPage(page, 'Send reply');
    await textHolding(page, 'Reply status', 'Reply saved');
    const answer = `Hello e2e@example.com, about ${subject}. We are on it.`;
    await textHolding(page, 'Conversation', answer);

    await page.goto(link);
    await textHolding(page, 'Conversation', answer);

    await page.goto(`/support/ticket?seeded#t=${SEEDED_TICKET_TOKEN}`);
    await textHolding(page, 'Conversation', 'Attachment removed after 30 days.');

    await page.goto('/support/ticket?unknown#t=nobody-holds-this');
    await textHolding(page, 'Support status', 'This link is no longer valid.');
  });

  test("sends a request from a product's TEST site, which its customer and the desk see as TEST", async ({ page, context }) => {
    const subject = `A test-version request ${String(Date.now())}`;
    await page.goto('/contact.html?product=demo-test');
    // Its own address, so the first journey's sends from every browser leave it under the 5-an-hour limit.
    await type(page, 'Email', 'e2e-test-site@example.com');
    await type(page, 'Subject', subject);
    await type(page, 'Message', 'Found on the test version.');
    await textHolding(page, 'Support status', 'Ready to send');
    await tap(page, 'Send');
    const link = await textHolding(page, 'Private link', '#t=');
    // The link opens on the TEST site, never the live one.
    expect(link, `the private link went to the live site: ${link}`).not.toContain('live.demo-test.example');

    // The customer's thread: their message, then the test-version reply first from the desk.
    await page.goto(link);
    await textHolding(page, 'Conversation', 'Found on the test version.');
    await textHolding(
      page,
      'Conversation',
      'Thanks for trying the test version of Demo Test. Your message has arrived safely. Requests from the live version of ' +
        'Demo Test are always answered first, so messages from the test version have no set reply time and may not always ' +
        'get a reply. Every report still helps make Demo Test better.',
    );

    // The desk marks it TEST in the list and on its page.
    const desk = await deskFor(context, link);
    await page.goto(`${desk}/desk?product=demo-test`);
    await textHolding(page, 'Ticket list', `TEST ${subject}`);
    await tapToNewPage(page, subject);
    await textHolding(page, 'TEST ticket', `From the TEST site ${new URL(link).origin}. Live tickets come first.`);
  });

  test("keeps every word and control readable on a product's dark page", async ({ page }) => {
    // The page sets only a dark product's theme (light text, dark form), as ShyTalk's does (shyden-labs/shydesk#282).
    await page.goto('/dark.html?product=demo');
    await type(page, 'Email', 'dark-page');
    await type(page, 'Subject', `Can I read this? ${String(Date.now())}`);
    await type(page, 'Message', 'Every letter should show on the field.');
    await type(page, 'Device', 'Test phone');
    await readable(page, ['Email', 'Subject', 'Category', 'Message', 'Device']);
    // A refused send shows its error lines; each word, button and field border reads on the dark form (shyden-labs/shydesk#299).
    await textHolding(page, 'Support status', 'Ready to send');
    await tap(page, 'Send');
    await textHolding(page, 'Support status', 'Check the fields marked below.');
    await sendEnabled(page, 'Send');
    await everyPartReadable(page);
    // Then sent: the private link and its status read on the dark form too.
    await type(page, 'Email', '@example.com');
    await textHolding(page, 'Support status', 'Ready to send');
    await tap(page, 'Send');
    await textHolding(page, 'Support status', 'The email could not be sent. Keep this link to follow the request.');
    await textHolding(page, 'Private link', '#t=');
    await everyPartReadable(page);
  });

  test('cannot load on a page whose origin the product does not allow', async ({ page }) => {
    // A known product whose only allowed origin is elsewhere: the browser refuses the answer (no CORS header).
    await page.goto('/contact.html?product=demo-elsewhere');
    const status = await textHolding(page, 'Support status', 'The support form could not load here.');
    expect(status.trim(), 'the status says more than that the form could not load').toBe('The support form could not load here.');
  });
});
