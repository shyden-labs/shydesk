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
import { JOURNEY_WAIT as WAIT, named, textHolding } from './harness/find.ts';
import { openPage } from './harness/open-page.ts';
import { clickMiddleOf, pickFile, press, pressVideoControl, swipeLeft, tap, tapToNewPage, type, zoomIn } from './harness/input.ts';
import { ownControlsPoints, type Box } from './harness/targets.ts';
import { SEEDED_TICKET_TOKEN, SHYDESK_PORT } from './harness/local-shydesk.ts';
import { playing, sizeKnown, untilVideo, watchVideo } from './harness/video.ts';

/** Waits until the page, shadow roots included, holds no media viewer: it closed. */
async function viewerClosed(): Promise<void> {
  await driver().waitUntil(
    () =>
      driver().execute<boolean>(
        'const walk = (root) => [...root.querySelectorAll("*")].some((e) => e.matches(\'[aria-label="Attachment viewer"]\') || (e.shadowRoot !== null && walk(e.shadowRoot))); return !walk(document);',
      ),
    { timeout: WAIT, timeoutMsg: 'the media viewer never closed' },
  );
}

/** Waits until the viewer's status says it is zoomed in past 100%. */
async function zoomedIn(): Promise<void> {
  const status = await named('Viewer status');
  let text = '';
  await driver().waitUntil(
    async () => {
      text = await status.getText();
      return Number(/zoom (\d+)%/.exec(text)?.[1] ?? 0) > 100;
    },
    { timeout: WAIT, timeoutMsg: `the viewer never zoomed in; its status said "${text}"` },
  );
}

/**
 * Fails unless every point where a browser draws its own video controls over the video named `label`
 * (its bottom bar, Chrome's button row, Safari's two top pills) is the video itself, not the drag layer.
 */
async function ownControlsUncovered(label: string): Promise<void> {
  const video = await named(label);
  const box = await driver().execute<Box>(
    'const r = arguments[0].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };',
    video,
  );
  for (const { at, where } of ownControlsPoints(box)) {
    const hit = await driver().execute<string>(
      'const v = arguments[0]; const hit = v.getRootNode().elementFromPoint(arguments[1], arguments[2]); return hit === v ? "video" : String(hit && hit.className);',
      video,
      at.x,
      at.y,
    );
    assert.equal(hit, 'video', `${where} of "${label}" at ${String(at.x)}, ${String(at.y)} is covered by "${hit}"`);
  }
}

/** Waits until the drag layer lies over the middle of the video named `label`, where its press is made. */
async function pictureTakesPress(label: string): Promise<void> {
  const video = await named(label);
  let hit = 'nothing read';
  try {
    await driver().waitUntil(
      async () => {
        hit = await driver().execute<string>(
          'const v = arguments[0]; const r = v.getBoundingClientRect(); const hit = v.getRootNode().elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return String(hit && (hit.className || hit.tagName));',
          video,
        );
        return hit === 'drag-layer';
      },
      { timeout: WAIT, timeoutMsg: `the middle of "${label}" never reached the drag layer` },
    );
  } catch (error) {
    throw new Error(`the middle of "${label}" never reached the drag layer; it reached "${hit}"`, { cause: error });
  }
}

/** Waits until the full-size picture named `label` has drawn. */
async function pictureDrew(label: string): Promise<void> {
  const picture = await named(label);
  await driver().waitUntil(async () => Number(await picture.getProperty('naturalWidth')) > 0, {
    timeout: WAIT,
    timeoutMsg: `"${label}" never drew`,
  });
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
    await openPage('/contact.html?product=demo');
    await type('Email', 'e2e');
    await type('Subject', subject);
    await type('Message', 'It closes as soon as it starts.');
    await type('Device', 'Test phone');
    // A refused send keeps saying why after the check hands over a new token, until the form changes
    // (shyden-labs/shydesk#242).
    await textHolding('Support status', 'Ready to send');
    await tap('Send');
    await textHolding('Support status', 'Check the fields marked below.');
    const send = await named('Send');
    await driver().waitUntil(async () => (await send.getProperty('disabled')) === false, {
      timeout: WAIT,
      timeoutMsg: 'the check never handed over a new token',
    });
    await textHolding('Support status', 'Check the fields marked below.', 5_000);
    await type('Email', '@example.com');
    await textHolding('Support status', 'Ready to send');
    // Too long is refused before any upload; then a video and a photo go straight to ShyDesk.
    await pickFile('Photos and videos', 'long-45s.mp4');
    await textHolding('Attachments', 'Videos can be up to 30 seconds long.');
    await pickFile('Photos and videos', 'ok-10s.mp4');
    // The piece gives up on shrinking after two minutes and sends the original.
    await textHolding('Attachments', 'attached,', 150_000);
    await pickFile('Photos and videos', 'photo.jpg');
    const attached = await attachedTwo();
    // shyden-labs/shydesk#21: each is stored smaller than its fixture, the 11,079 KB 2560×1440 video and the 3,011 KB photo.
    const [video = Infinity, photo = Infinity] = attached;
    assert.ok(video < 11079 && photo < 3011, `not stored smaller than the originals: ${attached.join(', ')} KB`);
    // The test site key passes by itself; the button is enabled once it has.
    await textHolding('Support status', 'Ready to send');
    await tap('Send');
    // The status first: if the request fails, its failure shows what the status line said.
    await textHolding('Support status', 'The email could not be sent. Keep this link to follow the request.');
    const link = await textHolding('Private link', '#t=');
    assert.match(link, /\/support\/ticket#t=[A-Za-z0-9_-]{43}$/);

    // The private link opens the conversation, and a reply typed there joins it (shyden-labs/shydesk#23).
    await openPage(link);
    await textHolding('Conversation', 'It closes as soon as it starts.');
    await type('Reply', 'It still closes.');
    await pickFile('Photos and videos', 'photo.jpg');
    await textHolding('Attachments', 'attached,');
    await tap('Send reply');
    await textHolding('Support status', 'Reply sent.');
    await textHolding('Conversation', 'It still closes.');
    await textHolding('Conversation', 'Attachment, ');
    // The preview of the reply's photo really came, through the token's header: after the first message's video and photo.
    // Found by its button's name, which every target gives it: iOS names a picture inside a button by the button
    // (shyden-labs/shydesk#144).
    const preview = await named('Open photo 3');
    const drawnWidth = 'const picture = arguments[0].querySelector("img"); return picture === null ? 0 : picture.naturalWidth;';
    await driver().waitUntil(async () => (await driver().execute<number>(drawnWidth, preview)) > 0, {
      timeout: WAIT,
      timeoutMsg: 'the third attachment preview never drew',
    });

    // The read-only viewer (shyden-labs/shydesk#25 AC3): a real wheel zooms, keys rotate and move on, a sideways drag
    // moves on again, the buttons zoom and rotate, and Esc closes it. Its three files: the video, the photo, the reply's photo.
    await tap('Open photo 3');
    await textHolding('Viewer status', 'Photo 3 of 3, zoom 100%, rotated 0°');
    await pictureDrew('Photo 3 full size');
    // How far one notch zooms depends on the wheel travel each browser reports, so only that it zoomed in is checked.
    await zoomIn('Viewer stage');
    await zoomedIn();
    await press('r');
    await press('r');
    await textHolding('Viewer status', 'rotated 180°');
    await textHolding('Viewer status', 'Photo 3 of 3, zoom ');
    await press('ArrowRight');
    await textHolding('Viewer status', 'Video 1 of 3, zoom 100%, rotated 0°');
    // shyden-labs/shydesk#108: a click on the video's picture plays it, and the browser's own controls,
    // along the bottom and the top of the picture, are left uncovered for the browser's pause and scrub.
    // What happens to the play is recorded, so a play Safari aborts names what aborted it (shyden-labs/shydesk#188).
    await watchVideo('Video 1 full size');
    // shyden-labs/shydesk#88: the 2560×1440 video was stored at no more than 1920×1080, on every browser.
    // The size is read once the metadata has loaded, never before (shyden-labs/shydesk#188).
    const shown = await untilVideo('Video 1 full size', sizeKnown, 'the video never reported its size');
    assert.ok(
      shown.width === 1920 && shown.height === 1080,
      `the video was stored at ${String(shown.width)}×${String(shown.height)}, not 1920×1080`,
    );
    // Until its size loads the video is drawn 150 px tall and the drag layer is too short to reach its
    // middle (Safari, PR shyden-labs/shydesk#217's first run), so the press waits for the layer to be there.
    await pictureTakesPress('Video 1 full size');
    await clickMiddleOf('Video 1 full size');
    // Playing means time has moved: paused turns false before any data loads (shyden-labs/shydesk#188).
    await untilVideo('Video 1 full size', playing, 'the video never started playing');
    await ownControlsUncovered('Video 1 full size');
    // AC2: a real press on the browser's own pause pauses it, and one on its scrub bar moves it on.
    await pressVideoControl('Video 1 full size', 'pause');
    await untilVideo('Video 1 full size', (v) => v.paused, "the browser's own pause never paused the video");
    await pressVideoControl('Video 1 full size', 'scrub');
    await untilVideo(
      'Video 1 full size',
      (v) => v.paused && v.currentTime >= 3,
      "the browser's own scrub bar never moved the 10 s video past 3 s",
    );
    // A sideways drag across the video moves on, as across a photo, on every browser.
    await swipeLeft('Viewer stage');
    await textHolding('Viewer status', 'Photo 2 of 3, zoom 100%, rotated 0°');
    await pictureDrew('Photo 2 full size');
    await swipeLeft('Viewer stage');
    await textHolding('Viewer status', 'Photo 3 of 3, zoom 100%, rotated 0°');
    await tap('Zoom in');
    await tap('Rotate left');
    await textHolding('Viewer status', 'Photo 3 of 3, zoom 125%, rotated 270°');
    await press('ArrowLeft');
    await textHolding('Viewer status', 'Photo 2 of 3, zoom 100%, rotated 0°');
    await press('Escape');
    await viewerClosed();

    // A rep signs in, switches product, opens the ticket, sends a canned reply they edited (shyden-labs/shydesk#24).
    const desk = new URL(link);
    desk.port = String(SHYDESK_PORT);
    await openPage(`${desk.origin}/health`);
    await driver().setCookies({ name: 'CF_Authorization', value: process.env.E2E_REP_TOKEN ?? '', path: '/' });
    await openPage(`${desk.origin}/desk?product=demo-elsewhere`);
    // The badge counts this run's unanswered tickets, once its first request is back.
    const badge = await named('Unread tickets');
    await driver().waitUntil(async () => /^\d+$/.test(await badge.getText()), {
      timeout: WAIT,
      timeoutMsg: 'the unread badge never showed a count',
    });
    await tapToNewPage('Demo');
    await tapToNewPage(subject);
    await textHolding('Conversation', 'It still closes.');
    // The rep views the same files read-only, streamed from the desk (shyden-labs/shydesk#25 AC2).
    await tap('Open photo 3');
    await textHolding('Viewer status', 'Photo 3 of 3, zoom 100%, rotated 0°');
    await pictureDrew('Photo 3 full size');
    await press('Escape');
    await viewerClosed();
    await tap('Thanks');
    await type('Your reply', ' We are on it.');
    await tapToNewPage('Send reply');
    await textHolding('Reply status', 'Reply saved');
    const answer = `Hello e2e@example.com, about ${subject}. We are on it.`;
    await textHolding('Conversation', answer);

    // The customer's page shows that reply.
    await openPage(link);
    await textHolding('Conversation', answer);

    // An attachment past its keeping time says so (seeded: tests/e2e/harness/local-shydesk.ts).
    await openPage(`/support/ticket?seeded#t=${SEEDED_TICKET_TOKEN}`);
    await textHolding('Conversation', 'Attachment removed after 30 days.');

    // A link nobody holds shows one plain line.
    await openPage('/support/ticket?unknown#t=nobody-holds-this');
    await textHolding('Support status', 'This link is no longer valid.');
  });

  it('cannot load on a page whose origin the product does not allow', async () => {
    // A known product whose only allowed origin is elsewhere: the browser refuses the answer (no CORS header).
    await openPage('/contact.html?product=demo-elsewhere');
    const status = await textHolding('Support status', 'The support form could not load here.');
    assert.equal(status.trim(), 'The support form could not load here.', 'the status says more than that the form could not load');
  });
});
