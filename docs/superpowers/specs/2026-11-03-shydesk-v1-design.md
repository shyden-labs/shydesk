# ShyDesk v1 design

Date: 2026-11-03. Status: approved by Shyden on 2026-11-03; revised 2026-11-04 for the headless rulings (shyden-labs/shydesk#30, then shyden-labs/shydesk#33: no product forward).
Decisions marked **(Shyden)** were made by Shyden; **(builder call)** are mine to check; everything else is left to the builder.

## Why

ShyDesk is the one support desk for every Shyden Labs product: Yawelo Idle, ShyTalk and shyden.co.uk. Yawelo Idle and ShyTalk cannot go live without it, and shyden.co.uk is waiting on it, so speed to a working first release matters more than breadth **(Shyden)**.

It is also public, open-source (Apache-2.0) software anyone can self-host for free, with no paid tier, quota or vendor lock-in that a self-hoster cannot remove **(Shyden)**. Anything specific to Shyden Labs (domains, accounts, products) is configuration, not code.

## Goals

1. Customers of any configured product can ask for help through a form on **that product's own support page**, attach photos and videos, and follow the conversation through a private link, without ever seeing a ShyDesk address.
2. Products can send reports (of a player, room, content...) into ShyDesk from inside their apps, and receive the punishments reps decide.
3. Reps work each product's tickets in isolation; the admin sees everything and alone handles appeals, ban lifts and legal holds.
4. A self-hoster adds products and decides each product's ticket types, reasons and punishments on a settings screen, without code.
5. Personal data is kept only as long as stated, with a legal hold for possible criminal evidence.

## Non-goals (v1)

- Inbound email: customers cannot email in **(Shyden)**.
- Emails to reps or the admin, of any kind **(Shyden)**.
- Translating anything: the staff desk is English forever; the customer side is English in v1 **(Shyden)**. Translation of customer pages, customer messages, text inside images and speech in videos are later stories (the last is a research story first).
- Telling a reporter the outcome of their report (later) **(Shyden)**.
- Custom roles, ticket assignment, reps attaching files to replies, per-language queues.

## Anti-goals (a failure even if it works)

- A rep for one product seeing another product's tickets, or any rep seeing an appeal.
- Evidence under legal hold being deleted, or suspected child-abuse material being shown to anyone.
- A cost that appears without a decision: everything runs inside free tiers at Shyden Labs' scale.
- Customer-facing text saying "we", "us", "our", "I" or "the team" (Shyden Labs house rule for public text; neutral wording).

## Releases **(Shyden)**

- **Release 1:** products and settings, the shared support piece (form with attachments and private ticket thread, embedded in each product's page), staff desk with media viewer, canned replies, reps and per-product access, no-reply emails, retention and deletion. Unblocks shyden.co.uk and the support side of both games.
- **Release 2, straight after:** reports API, punishments, appeals, legal holds, repeat-offender history.

The data model is designed for both from the start, so Release 2 adds rather than migrates.

## Platform **(Shyden unless marked)**

- **Hosting:** Cloudflare Workers (free plan), D1 database, R2 for attachments, Turnstile on the customer form. ShyDesk has **its own new Cloudflare accounts, "ShyDesk" (live) and "ShyDesk Non-Prod" (test+dev)** **(Shyden 2026-11-04)**. Live runs on the **free domain `shydesk.dpdns.org`** (DigitalPlat FreeDomain, delegated to the live account's Cloudflare nameservers) **(Shyden 2026-11-04: "use a free domain")**; Non-Prod runs on its `workers.dev` address, used only by tests and the products' dev sites.
- **Reachability from Indonesia (measured 2026-11-04 on Biznet):** Indonesian ISPs block by DNS at their own discretion. `*.r2.dev` is hijacked to Biznet's block page even for queries sent to 1.1.1.1; a random name under `workers.dev`, `dpdns.org`, `eu.org` and the other free suffixes returns no-such-name (not blocked as a whole). Shyden chose a free domain knowing a shared free suffix carries the same or higher block risk than `workers.dev`, and that a paid domain would carry the least. Nothing customer-facing uses an `r2.dev` address.
- **Staff sign-in:** Cloudflare Access with an email allow-list (free to 50 users). An Access application covers the `/desk`, `/admin` and `/api/docs` paths on ShyDesk's host. The Worker verifies the Access JWT on every desk and admin request **(builder call)**; it never trusts a header without verifying it.
- **Outgoing mail:** Oracle OCI Email Delivery (Always Free, 3,000 a month), no-reply only. What Oracle keeps of message content, and for how long, must be found out and written into the privacy policy before launch.
- **Data region:** Shyden Labs is in Indonesia; never assume UK or EU hosting. D1 location hint Asia-Pacific **(builder call)**.
- **Language and tooling:** TypeScript, on the repo-template toolchain already in the repo (Vitest, ESLint, Prettier, tsc). Framework choices are the builder's, under the licence rule: shipped packages permissive only (MIT, BSD, Apache, ISC); MPL/LGPL only for build or test tools; GPL, AGPL, SSPL refused.

## Products and modules **(Shyden)**

A **product** (e.g. `yawelo-idle`, `shytalk`, `shyden-co-uk`) is added on the admin settings screen. Each product has:

- display name, its id (e.g. `shytalk`), and its **ticket page address**: the page on the product's own site where the shared piece shows a customer's ticket; no-reply emails link there;
- its **allowed origins**: the product's own site origins (e.g. `https://shytalk.app`) that may embed the shared piece; they drive CORS and the Turnstile hostname check;
- its **sender address on its own domain** (e.g. `no-reply@shytalk.app`) **(Shyden)**, set in settings because product domains change (Yawelo Idle's will move to a new domain soon); the product's domain carries the sending records (SPF, DKIM) Oracle gives;
- **ticket types** it offers, each one of:
  - **support**: two-way conversation via the private link;
  - **report**: fire-and-forget; a list of **reasons** (required pick), optional note, evidence;
  - **appeal**: one per punishment, admin-only;
- for each type: its extra form fields (e.g. an optional player ID), its reason list, the canned replies that fit it;
- (Release 2) its **punishments** (e.g. "ban 7 days", "remove room"), and a callback address plus signing secret for sending them to the product;
- an **API key** for the product's own systems (Release 2 for reports; Release 1 can already expose read access for dashboards);
- retention overrides (defaults below).

Changes on the settings screen apply at once, with no deploy.

## Release 1 in detail

### Customer side (English)

**Headless (Shyden 2026-11-04):** ShyDesk hosts no customer pages. Each product's own support page embeds **one shared piece**, built once in this repo, that every product drops in rather than rebuilding **(Shyden: "yes shared piece")**. The piece contains the contact form, Turnstile, photo and video compression and upload, the private ticket thread with replies, and (Release 2) the appeal form. **The piece talks straight to ShyDesk; nothing passes through a product's server**, above all no customer photo or video **(Shyden 2026-11-04: "make sure it only goes through shydesk")**. Products only add the embed.

- **The shared piece** **(builder call)**: a script at `https://shydesk.dpdns.org/embed.js` defining a custom element `<shydesk-support product="<id>" view="contact|ticket" lang="...">`. It renders in a shadow root and takes its colours and fonts from CSS custom properties the product sets. Every product always runs the version that matches the API, and nothing is published to npm. A product's link can still preset fields (e.g. category) through attributes.
- **Which product a request is for** **(builder call)**: the `product` attribute is sent with each call. ShyDesk accepts it only when the browser's `Origin` is one of that product's allowed origins (CORS answers only those origins), and for a new ticket also only when the Turnstile verification's `hostname` is one of them. A script outside a browser can forge `Origin`, but not a Turnstile token for another site, and reading or replying needs the ticket's own token.
- **Contact form** (the piece's `contact` view). Fields: email, subject, category, message, product-specific extra fields, attachments. Turnstile on submit, with one widget whose allowed hostnames are the product domains; ShyDesk verifies the token with the client IP Cloudflare reports (`CF-Connecting-IP`) and checks the returned hostname against the product's origins. Rate limit per email and per client IP **(builder call)**. The `lang` attribute is accepted and ignored in v1, kept for the translation story.
- **Attachments: photos and videos (Shyden).** Videos up to **30 seconds** (a length limit, not a size limit) **(Shyden)**. Compression happens **in the customer's browser** before upload, without visible quality loss, using the browser's built-in media encoders **(Shyden)**. A browser that cannot compress uploads the original. The server enforces, whatever the browser does: video length ≤ 30 s (read from the file's container header), allowed file types by content not name, and a per-message attachment count (the builder picks it, stated in the plan). **No per-file size limit** (Shyden, 2026-11-03: limit by length, not size); only total free storage can refuse an upload. Uploads go **straight from the browser to ShyDesk in parts of at most 8 MB**, which ShyDesk writes into an R2 multipart upload through its bucket binding **(builder call, 2026-11-04)**. The free plan caps one request body at 100 MB and an uncompressed original has no size cap, so a single request could fail; parts keep every request small. Nothing goes to an R2 or `r2.dev` address, so there are no signed URLs, no R2 API token and no bucket CORS. A ticket only references a file after the server has checked it.
- After submit: the piece shows a confirmation with the **private ticket link**, and a no-reply email sends the same link **(Shyden)**. The link is the product's ticket page address with a long random token in the fragment (`#t=<token>`), so the token never appears in any request log. The piece sends it to the API in an `Authorization: Ticket <token>` header, never in a path or query **(builder call)**.
- **Private ticket view** (the piece's `ticket` view, on the product's ticket page): the thread and attachments; the customer can reply (with attachments) there. Replying reopens a closed ticket. No account.
- Every customer email is no-reply and only says there is something new, with the private link; never the reply text itself **(builder call: keeps content out of the mail provider)**.

### Staff desk

- **Product switcher:** reps see only products granted to them; admin also has "All products" **(Shyden; switcher layout builder call)**.
- **Ticket list:** filter by product, type and status; tickets waiting on staff oldest first; live unread badge for new tickets and customer replies **(builder call: replaces email alerts, which Shyden ruled out)**.
- **Ticket view (Shyden):** ticket information and thread as text; a separate **attachments** section of thumbnails (video thumbnails show a frame and length); clicking opens a **read-only media viewer** with zoom, rotate, and for video play/pause and scrubbing, and next/previous without closing. Nothing in the viewer changes or deletes the stored file.
- **Reply** with **canned replies** **(Shyden)**: reps pick a saved reply by name from the reply box, it fills in (with placeholders such as the customer's name), and they edit before sending.
- **Statuses:** Open (waiting on staff), Waiting on customer (after a staff reply), Closed. Reps close by hand; Waiting on customer for 7 days closes itself; a customer reply reopens **(builder call, Shyden saw and did not object)**.
- **Feed for product dashboards:** a cursor-paged API read (`GET ...?since_cursor=`) of new and changed tickets per product, polled by the product's portal only while a staff page is open; no webhooks in v1, so each product's own dashboard (to be planned) can show rep notifications **(Shyden: reps get notifications in their product's dashboard)**.

### Roles **(Shyden)**

- **Admin:** everything. Settings, reps and their products, all tickets.
- **Rep:** for granted products only: view tickets and attachments, reply, close; (Release 2) apply punishments, place a legal hold.
- **Admin only:** appeals (reps never see them, not even a count), lifting bans, lifting legal holds, settings.
Isolation is enforced on the server for every query and file, not by hiding things in the page.

### Retention (defaults; each configurable per product)

- **Attachments:** deleted **30 days after the ticket closes** **(Shyden)**, unless under legal hold. A reopen restarts the clock.
- **Ticket and report text:** deleted **1 year after close** **(Shyden)**, unless under legal hold. Research (2026-11-03): GDPR, UK GDPR, Indonesia's PDP law and California's CCPA set no maximum, only "no longer than necessary" plus stating the period; Shyden chose 1 year.
- **No scheduled jobs (Shyden: "i don't like scheduled jobs like this ... such as a TTL").** Expiry works like a TTL, with **a timer per ticket**: when a ticket closes (or enters Waiting on customer, for the 7-day auto-close), ShyDesk sets that ticket's own Cloudflare Durable Object alarm (free plan) for its exact expiry. A reopen cancels it, and a legal hold blocks it (the alarm re-checks for holds when it fires and does nothing if one exists). Nothing runs on a clock, and an idle ShyDesk costs nothing.
- **A failed timer can't hide:** the admin desk shows any item still stored after its expiry date (worked out when the page loads, with no job), so a missed deletion is seen and fixed by its cause, never by retrying blindly.
- ShyDesk keeps a running total of stored bytes, updated on every upload and delete. Over 80% of R2's free 10 GB, the admin desk shows a warning, and over 100% it refuses new uploads with a clear message rather than incurring a cost **(builder call; no clock, no email)**.

## Release 2 in detail

### Reports API **(Shyden)**

- **The product's server, never its app,** sends a report through the API with its product API key **(agreed with the ShyTalk session)**. The key lives only as a server secret: anything shipped in a phone app or web page can be extracted. The app sends the report to its own server, which checks the reporter's session and rate-limits, then calls ShyDesk. ShyDesk treats `reporter_id` as asserted by the product's server. Evidence uploads: the product's server requests a short-lived upload grant and hands it to the app, which uploads the parts straight to ShyDesk like the shared piece does (never to an R2 address, never through the product; 2026-11-04). The report carries the reporter's ID, the reported item (player, room, message...) and its ID, the chosen reason, optional note, evidence (same upload rules as the form), and context the app fills in itself.
- The reporter gets "received" from the app and nothing more.
- The report shows in the desk and through the API to the product's dashboard, with the reported user's earlier reports and punishments **in that product only** **(builder call)**.

### Punishments **(Shyden)**

- A rep picks one of the product's punishments on a report. ShyDesk records it and sends it to the product's callback, signed so the product can verify it came from ShyDesk: HMAC-SHA256 over `timestamp + "." + raw body` with the per-product secret, rejected by the product if the timestamp is more than 5 minutes off, and idempotent on ShyDesk's punishment ID (a replay returns the first result without applying twice). The product answers 200 `{applied: true, ...}` or 4xx/5xx `{error: code}` **(agreed with the ShyTalk session)**. The product carries it out and answers; ShyDesk shows whether it was applied. A failed send is shown on the ticket and fails loudly, never retried silently.
- Only the admin can lift a ban.

### Appeals **(Shyden)**

- Two ways in: the shared piece's **appeal view** on the product's own site, linked from the product's ban notice (works for banned users, prefilled with the punishment reference), and **from inside the product**, sent by the product's server through the API (never with a key in the app).
- **One appeal per punishment.** Once rejected, no further appeal is accepted.
- Appeals are visible to the admin only. An upheld appeal lifts the punishment through the same signed callback.

### Legal hold **(Shyden)**

- Any rep can place a legal hold on a ticket or a single attachment; only the admin can lift one. Who, when and why are recorded.
- **Held items are never deleted automatically** **(Shyden: "make sure items are not deleted to comply with the law")**. The retention job skips anything under a hold. Each hold records its reason and the earliest date the law allows release; until then even the admin cannot lift it or delete the item. After that date the hold comes up for admin review, and nothing is deleted without the admin deciding.
- Hold reasons and their minimum keep **(builder proposal, to be confirmed by the lawyer check below)**:
  - **possible crime, not yet reported:** kept until the admin either reports it or records why no report is needed;
  - **reported to authorities:** at least **1 year from the date of the report** (the REPORT Act's period runs from the report, not from the hold);
  - **law-enforcement preservation request:** at least 90 days from the request, extended by 90 for each renewal, and until any production order is answered.
- A hold marked **suspected child-abuse material** hides the files from every viewer, admin included; the desk shows only that evidence exists.
- **Report to the authorities (Shyden, from a side agent's note):** a hold is not a report. A suspected child-abuse hold opens a required **"report to the authorities"** step for the admin: the admin reports it (in v1 by hand, to NCMEC's CyberTipline and/or the competent Indonesian authority, as the lawyer advises) and records where, when and the report reference in ShyDesk. Until that is recorded the ticket shows as an outstanding legal duty at the top of the admin's desk and cannot be closed. Sending reports to NCMEC automatically through its reporting API is a later story.
- **Lawyer check before Release 2 ships (Shyden):** a lawyer confirms, for Indonesia and for the main countries users are in, whether holding this material is lawful and on what terms, who must be told and how fast, and the minimum keep periods above. In several countries holding such material without reporting it is itself a crime; Indonesia was not checked. Release 2's legal-hold and report features do not go live until that advice is in and the design matches it.
- Research basis (2026-11-03, not legal advice; a lawyer to confirm before launch): US 18 U.S.C. 2258A as amended by the REPORT Act (2024) requires providers to keep CyberTipline report material 1 year; US 18 U.S.C. 2703(f) preservation requests are 90 days plus a 90-day renewal; EU DSA Article 18 requires notifying police of suspected crimes threatening life or safety; DSA Article 20's 6-month appeal window does not apply to micro and small enterprises (Article 19).

## API

Shipped API, so per Shyden Labs rules: a hand-written OpenAPI spec checked by contract tests, served with self-hosted `swagger-ui-dist` behind Access; write calls tried on dev only. Two surfaces:

- **Customer API** under `/support-api/*`, called by the shared piece straight from the customer's browser; CORS limited to each product's allowed origins; Turnstile for new tickets, the ticket token for reading and replying.
- **Product API** under `/api/v1/*`, called by product servers (server to server), authenticated by a per-product API key scoped to that product's tickets only.

## Testing and checks

Repo-template rules apply: strict TDD; unit tests with mocks only (no network, no processes), each under 1 s; integration and end-to-end suites run in CI against real services (D1/R2 on the dev account) and drive the UI with real input; one overall coverage percentage enforced in CI; SonarCloud gate. End-to-end tests drive the shared piece embedded in a small demo product page on its own origin on the Non-Prod account, so CORS and the origin checks are tested across origins. Mobile: the shared piece is tested on real Android and iOS phones on each product's real support page before release (attachments from the phone camera roll especially), and Shyden signs off.

## Further builder calls (from the builder read-through)

- **Stored formats:** videos stored as MP4 (H.264 video, AAC audio) so every desk browser can play them; photos as JPEG or WebP. iPhone HEIC photos and HEVC `.mov` videos are converted in the browser where it can; the server accepts only the stored formats.
- **First admin:** set by an environment variable at install (an email address); further admins and reps are managed on the settings screen.
- **Private links** stay valid until the ticket's text is deleted. Anyone typing someone else's email only sends that person a link to a ticket they did not write; no data leaks.
- **Free-plan limits:** the plan measures CPU time per request against the Workers free limit early (JWT check, upload checks), as the support-system summary's open question 10 asked; if a route cannot fit, it is raised with Shyden before any paid plan.
- **Sending mail from a Worker:** the plan confirms OCI Email Delivery's HTTPS submission route works from Workers before building on it.

## Left to the builder

Web framework and rendering approach, the browser media libraries (licence rule above), the attachment count per message (stated in the plan), table design, token format, rate-limit numbers, how the desk's live badge updates, and the order of work within each release, starting with foundations (Cloudflare accounts, Oracle account, keys).
