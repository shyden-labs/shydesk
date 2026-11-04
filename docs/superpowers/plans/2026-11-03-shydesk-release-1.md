# ShyDesk Release 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ShyDesk Release 1: per-product settings, the shared support piece every product embeds (contact form with photo and video attachments, the customer's private ticket thread) behind each product's own forward, and the staff desk with media viewer, canned replies and per-product reps, on Cloudflare's free tier.

**Architecture (headless, revised 2026-11-04 for shyden-labs/shydesk#30):** One Cloudflare Worker (Hono router) on its account's `workers.dev` host serves the staff desk, the product API, and the customer API under `/support-api/*`, which customers reach only through each product's own domain (the product's forward adds a per-product forward key). ShyDesk also serves the shared piece, `/support-api/embed.js`, through the same forward. D1 holds all records, R2 holds attachments (uploaded through the forward in parts of at most 8 MB into an R2 multipart upload via the bucket binding), and one Durable Object per ticket holds that ticket's expiry alarms. Staff sign in through Cloudflare Access; the Worker verifies the Access JWT itself. No-reply mail goes out through Oracle OCI Email Delivery's HTTPS API.

**Tech Stack:** TypeScript (repo-template toolchain: Node 26.12.1, Vitest, ESLint, Prettier, tsc), Cloudflare Workers + D1 + R2 + Durable Objects + Turnstile + Access, `wrangler` (dev tool), `hono` (MIT), `jose` (MIT), browser side `mp4box` (BSD-3-Clause) and `mp4-muxer` (MIT) over WebCodecs, `swagger-ui-dist` (Apache-2.0), Playwright (Apache-2.0) for end-to-end in CI.

**Spec:** `docs/superpowers/specs/2026-11-03-shydesk-v1-design.md` (approved 2026-11-03, headless revision 2026-11-04). Read it with this plan.

**Stories:** epic shyden-labs/shydesk#12; Task 0 shyden-labs/shydesk#13, Task 1 shyden-labs/shydesk#14, Task 2 shyden-labs/shydesk#15, Task 3 shyden-labs/shydesk#16, Task 4 shyden-labs/shydesk#17, Task 5 shyden-labs/shydesk#19, Task 6 shyden-labs/shydesk#20, Task 7 shyden-labs/shydesk#18, Task 8 shyden-labs/shydesk#21, Task 9 shyden-labs/shydesk#23, Task 10 shyden-labs/shydesk#24, Task 11 shyden-labs/shydesk#25, Task 12 shyden-labs/shydesk#22, Task 13 shyden-labs/shydesk#26, Task 14 shyden-labs/shydesk#27.

## Global Constraints

- Free tier only: Workers Free, D1, R2 (10 GB), Durable Objects (SQLite-backed, free), Turnstile, Access (≤ 50 users), OCI Email Delivery Always Free. Anything needing a paid plan stops and goes to Shyden.
- One Oracle account, ShyDesk only; each product has a monthly email share set in settings (Shyden 2026-11-03).
- No scheduled jobs and no cron (Shyden). Expiry = a Durable Object alarm per ticket.
- No email to reps or admins, ever. Customer emails are no-reply, say only "something new" plus the private link, and come from the product's own sender address.
- Customer side English only in v1; the shared piece accepts a `lang` attribute (BCP-47) and ignores it in v1 (kept for the translation story).
- Customers never reach `workers.dev` or any R2 address: every customer request goes to the product's own domain and through its forward (Shyden 2026-11-04). `/support-api/*` without a valid `X-ShyDesk-Forward-Key` is 404.
- Customer-facing copy: no "we", "us", "our", "I", "me", "my", "the team", "solo". Neutral wording.
- Shipped packages: MIT, BSD, Apache-2.0, ISC only. MPL/LGPL only for build/test tools. GPL/AGPL/SSPL refused (so no `mediabunny` (MPL-2.0) and no `ffmpeg.wasm` in the shipped bundle).
- Exact versions, each published at least two weeks before install; Dependabot covers npm with `target-branch: "develop"`.
- Data region: D1 location hint `apac`. Never UK/EU defaults.
- Unit tests: mocks only, no network, no child process, each under 1 s. Integration and e2e run in CI against the real dev account, drive the UI with real input (Playwright `click`, `fill`, keyboard, real wheel/touch), never `el.click()` or set `.value`.
- Isolation is enforced in SQL on every query (`product_id IN (...)`), never only in the page.
- Retries are not fixes: a failed send or alarm is shown and fails loudly.
- Values fixed by this plan (builder calls the spec left open): **no per-file size limit** (Shyden: videos are limited by length, not size), **10** attachments per message, video ≤ **30 s**, sensible compression (Shyden 2026-11-03: "compressed well without causing quality to drop too much, but 4k is obviously too much"): photos scaled to at most **2560 px** on the long edge and saved as JPEG quality **0.85**; videos scaled to at most **1080p** (long edge ≤ 1920), frame rate capped at **30 fps**, H.264 at **5 Mbit/s** with AAC **128 kbit/s** (a 30 s clip is about **19 MB**, so the free 10 GB holds roughly 500); the original is kept only when the re-encode is not smaller; rate limits **5 tickets per email per hour** and **20 per forwarded client IP per hour**; upload parts **≤ 8 MB** (R2's multipart minimum is 5 MiB for every part but the last), an unfinished upload aborted after **1 hour**; forward keys **32 random bytes, base64url, stored as SHA-256**; customer tokens **32 random bytes, base64url**; API keys stored as **SHA-256** hashes.

## Review Focus

1. A rep granted only `shytalk` requesting a `yawelo-idle` ticket, attachment, canned reply or feed page by ID: expect 404 (not 403, so existence does not leak). Pinned in Tasks 4, 9, 10, 12.
2. A video that claims to be 29 s in the browser but whose container says 45 s, or a `.mp4` that is really an HTML file: expect the upload's `complete` call to refuse it and delete the object. Pinned in Task 6.
6. A browser calling `/support-api/*` on the workers.dev host directly, or a page sending its own `X-ShyDesk-Forward-Key` for another product through a forward: expect 404 for the first, and the forwarder's own key (not the browser's) deciding the product for the second. Pinned in Tasks 5 and 8.
3. A customer replying to a ticket that closed 29 days ago (attachments still stored) and one closed 31 days ago (attachments gone): expect reopen in both; the second shows "attachment removed after 30 days". Pinned in Task 11.
4. Storage at 99.9 % when an upload whose declared size would pass the free 10 GB is requested: expect refusal before any part is accepted, with the message from Task 6. Pinned in Task 6.
5. A product's monthly email share used up: expect the ticket still created and the page saying the email could not be sent, with the private link shown on screen so the customer is not stranded. Pinned in Task 7.

---

### Task 0: Foundations (Shyden runs; agent reads back)

Nothing in later tasks can deploy until these exist. Each step is done by Shyden in a dashboard; the agent then reads it back and records the result in the repo's `CLAUDE.md` (names and IDs only, never secret values).

- [ ] **Step 1: Cloudflare accounts (Shyden 2026-11-04).** New accounts "ShyDesk" (live) and "ShyDesk Non-Prod" (test+dev), created by Shyden; each account's `workers.dev` subdomain chosen and recorded. No domain. Hosts: `shydesk.<live-subdomain>.workers.dev` and `shydesk.<nonprod-subdomain>.workers.dev`, read back with `curl -sI` once Task 1 deploys.
- [ ] **Step 2: Per account:** D1 database `shydesk` (location hint `apac`); R2 bucket `shydesk-attachments` (no public access, no `r2.dev`, no CORS, no R2 API token: the Worker uses its binding); one Turnstile widget whose hostnames are the product domains (the free plan allows up to 10 hostnames per widget; a self-hoster with more adds widgets) (`shyden.co.uk`, `shytalk.app`, Yawelo Idle's current domain; on Non-Prod, the products' dev hosts plus the demo host from Task 5); a Cloudflare Access application on the workers.dev host covering `/desk/*`, `/admin/*`, `/api/docs/*` with an email allow-list (Shyden first), and an Access service token for CI on Non-Prod only. Path-based Access on a workers.dev host is documented (developers.cloudflare.com/workers/configuration/cloudflare-access/) but a 2020 report says it once did not gate; read back after Task 1 deploys: `curl -sI` on `/desk/` gets the Access redirect and `/health` does not.
- [ ] **Step 3: Oracle.** One OCI account (Shyden's, Always Free), Email Delivery in a region near Indonesia (e.g. `ap-singapore-1`), an API signing key for a user with only Email Delivery send rights, and approved senders: `no-reply@shyden.co.uk` first. DKIM record per product domain; send each product session its DKIM record and the region's SPF include. shyden.co.uk's existing MX, SPF and DMARC stay untouched.
- [ ] **Step 4: GitHub environments.** `dev` (allows `develop` only) holding the dev account's Cloudflare API token and secrets; `production` (allows `main` only, required reviewer `ShydenMcM`) holding the live token and secrets. No repository-level secrets.
- [ ] **Step 5: Confirm OCI sends from a Worker.** One throwaway Worker on the dev account sends one email to Shyden through OCI's HTTPS `SubmitEmail` with request signing. Record the exact endpoint and the response here. If it cannot, stop and raise with Shyden before Task 7.
- [ ] **Step 6: Measure CPU.** In the same throwaway Worker, time the Access JWT verify (`jose.jwtVerify` with a cached JWKS), an MP4 `mvhd` parse of a 64 KB range, and one 8 MB part streamed into an R2 multipart `uploadPart`. Record all three. Both must fit the free plan's per-request CPU limit with margin; if not, stop and raise with Shyden.

### Task 1: Worker skeleton and real dev deploy

**Files:**
- Create: `src/index.ts`, `src/env.ts`, `wrangler.jsonc`, `tests/unit/health.test.ts`, `vitest.integration.config.ts`
- Modify: `scripts/deploy-dev.ts` (map `src/`, `migrations/`, `public/`, `wrangler.jsonc` to the Worker deploy, and `demo-host/` to the demo deploy from Task 5), `.github/workflows/deploy-dev.yml`, `tsconfig.json` (add `@cloudflare/workers-types`, `"lib": ["es2024", "dom"]` for the browser modules under `public/src`), `vitest.unit.config.ts` (coverage include `src/**/*.ts`), `package.json`
- Create: `.github/workflows/deploy-prod.yml` (runs on `main` only, environment `production`)

**Interfaces:**
- Produces: `export interface Env { DB: D1Database; FILES: R2Bucket; TICKET_TIMER: DurableObjectNamespace; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; FIRST_ADMIN_EMAIL: string; TURNSTILE_SECRET: string; OCI_TENANCY: string; OCI_USER: string; OCI_FINGERPRINT: string; OCI_PRIVATE_KEY: string; OCI_REGION: string; FREE_STORAGE_BYTES: string }` in `src/env.ts`; `export const app: Hono<{ Bindings: Env }>` in `src/index.ts`.

- [ ] **Step 1:** Test `GET /health` returns 200 `{"ok":true}` via `app.request('/health', {}, env)` with a mocked `Env`. Run `npm run test:unit -- health`; expect FAIL (module missing).
- [ ] **Step 2:** Add `hono`, `wrangler`, `@cloudflare/workers-types` (exact, ≥ 2 weeks old), implement `app` with `/health`. Run; expect PASS.
- [ ] **Step 3:** `deploy-dev.ts`: test that a change under `src/` returns the deploy area `worker` and that `docs/` still deploys nothing; then the workflow runs `npx wrangler deploy --env dev` and `npx wrangler d1 migrations apply shydesk --env dev --remote` only when `worker` changed and `DEPLOY_REHEARSAL` is not `true`. Update `tests/unit/deploy-dev.test.ts` for the new step text.
- [ ] **Step 4:** `deploy-prod.yml`: test (plain text test like `deploy-dev.test.ts`) that it triggers on `push: branches: [main]` only and uses `environment: production`.
- [ ] **Step 5:** Run `npm run test:coverage`, `npm run typecheck`, `npm run lint`. Commit `feat: worker skeleton with dev and prod deploys`. After merge, read `https://shydesk.<nonprod-subdomain>.workers.dev/health`.

### Task 2: Database schema

**Files:**
- Create: `migrations/0001_release_1.sql`, `src/db/types.ts`, `tests/integration/schema.test.ts`

**Interfaces:**
- Produces (tables; Release 2 adds `holds`, `punishments`, `appeals`, `reports` without altering these):
  - `products(id TEXT PK, name, sender_address, ticket_page_url, forward_key_hash TEXT UNIQUE, monthly_email_share INTEGER, attachments_keep_days INTEGER DEFAULT 30, text_keep_days INTEGER DEFAULT 365, created_at)`
  - `ticket_types(id TEXT PK, product_id FK, kind TEXT CHECK(kind IN ('support','report','appeal')), name, fields_json TEXT, reasons_json TEXT, enabled INTEGER)`
  - `staff(email TEXT PK, role TEXT CHECK(role IN ('admin','rep')), created_at)`, `staff_products(email FK, product_id FK, PK(email, product_id))`
  - `tickets(id TEXT PK, product_id FK, type_id FK, status TEXT CHECK(status IN ('open','waiting','closed')), customer_email, subject, category, fields_json, token_hash TEXT UNIQUE, created_at, updated_at, closed_at, seq INTEGER)` with index `(product_id, status, updated_at)` and `(product_id, seq)`
  - `messages(id TEXT PK, ticket_id FK, author TEXT CHECK(author IN ('customer','staff')), staff_email, body, created_at)`
  - `attachments(id TEXT PK, product_id FK, ticket_id FK NULL, message_id FK NULL, r2_key, r2_upload_id, thumb_key, mime, bytes INTEGER, duration_ms INTEGER NULL, state TEXT CHECK(state IN ('pending','stored','deleted')), created_at, deleted_at)` (`product_id` set at start so a forward key can only finish its own product's uploads)
  - `canned_replies(id TEXT PK, product_id FK, type_id FK NULL, name, body)`
  - `api_keys(hash TEXT PK, product_id FK, label, created_at, revoked_at)`
  - `counters(key TEXT PK, value INTEGER, window_start)` (rate limits, monthly email use, stored bytes)
  - `reads(email, ticket_id, read_seq, PK(email, ticket_id))` (unread badge)
  - `feed_seq` via `tickets.seq` assigned from `counters['feed_seq']` on every change.
- [ ] **Step 1:** Integration test (CI, real dev D1 via `wrangler d1 execute --remote` in a disposable database created per run and deleted after): every table exists, the CHECK constraints refuse a bad `status` and `role`. Expect FAIL.
- [ ] **Step 2:** Write the migration. Expect PASS in CI. Commit `feat: release 1 schema`.

### Task 3: Staff sign-in, roles and product scope

**Files:**
- Create: `src/auth/access.ts`, `src/auth/staff.ts`, `tests/unit/access.test.ts`, `tests/unit/staff.test.ts`

**Interfaces:**
- Produces: `verifyAccess(request: Request, env: Env, jwks?: JWTVerifyGetKey): Promise<{ email: string }>` (throws `AuthError` 401); `loadStaff(db: D1Database, email: string, firstAdmin: string): Promise<Staff | null>` where `type Staff = { email: string; role: 'admin' | 'rep'; products: string[] }`; `scope(staff: Staff, requested?: string): string[]` (admin: all, or the one requested; rep: their grants ∩ requested, empty if not granted); Hono middleware `requireStaff` setting `c.var.staff`.
- [ ] **Step 1:** Tests: a JWT signed by a test key with the right `aud` and `iss` passes; wrong `aud`, expired, missing header, and the `Cf-Access-Authenticated-User-Email` header alone without a JWT each throw 401. `FIRST_ADMIN_EMAIL` is admin even with no `staff` row. A rep with `['shytalk']` asking for `yawelo-idle` gets `[]`. Expect FAIL.
- [ ] **Step 2:** Implement with `jose.createRemoteJWKSet(new URL(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`))`. Expect PASS. Commit.

### Task 4: Admin settings screen

**Files:**
- Create: `src/admin/routes.ts`, `src/admin/views.tsx`, `src/products.ts`, `tests/unit/products.test.ts`, `tests/e2e/admin-settings.spec.ts`

**Interfaces:**
- Consumes: `requireStaff`, `scope`.
- Produces: `listProducts(db)`, `getProduct(db, id)`, `saveProduct(db, p: ProductInput)`, `saveTicketType(db, t: TicketTypeInput)`, `saveCanned(db, c)`, `grantRep(db, email, productIds: string[])`, `createApiKey(db, productId, label): Promise<string>` (returns the key once; stores SHA-256); `rotateForwardKey(db, productId): Promise<string>` (returns the new key once; the old one stops at once); `productByForwardKey(db, key): Promise<Product | null>`.
- Admin-only routes under `/admin`: products (id, name, sender address, ticket page URL, forward key (rotate, shown once), monthly email share, keep-days), support ticket type and its extra fields (`text`, `select`; each with label, required), canned replies per product and type, staff (email, role, product grants), API keys (create, revoke). A rep gets 404 on every `/admin` route.
- [ ] **Step 1:** Unit tests for each function's validation: product id matches `^[a-z0-9-]{2,40}$`; sender address must end in a domain (no validation of DNS here); ticket page URL must be `https:` with no fragment; a forward key is returned once and only its hash is stored; `monthly_email_share ≥ 0`; keep-days ≥ 1; a rep cannot be granted a missing product; an API key is returned once and only its hash is stored. Expect FAIL, implement, PASS.
- [ ] **Step 2:** e2e (CI, dev): admin adds product `test-<run>` with real typing and clicks, adds a canned reply, grants a rep; the rep's session gets 404 on `/admin`. Commit.

### Task 5: Forward check, contact API, shared piece and demo host

**Files:**
- Create: `src/customer/forward.ts`, `src/customer/contact.ts`, `src/tickets.ts`, `src/limits.ts`, `src/turnstile.ts`, `public/src/embed/element.ts`, `public/src/embed/contact-view.ts`, `public/src/embed/api.ts`, `demo-host/worker.ts`, `demo-host/index.html`, `demo-host/wrangler.jsonc`, `examples/forward-node.ts`, `docs/forwarding.md`, tests for each under `tests/unit/`, `tests/e2e/contact.spec.ts`

**Interfaces:**
- Produces: middleware `requireForward` on `/support-api/*`: looks up `X-ShyDesk-Forward-Key` by hash (`productByForwardKey`), sets `c.var.product` and `c.var.clientIp` (from `X-ShyDesk-Client-IP`), 404 when the key is missing or unknown, 400 naming the header when a valid key comes without a client IP (never one shared rate-limit bucket); nothing under `/support-api` reads a product id from the request.
- Produces: `createTicket(db, input: NewTicket): Promise<{ id: string; token: string }>` (token returned once, `token_hash` stored); `verifyTurnstile(secret, token, ip): Promise<boolean>`; `hit(db, key: string, limit: number, windowSeconds: number): Promise<boolean>`.
- `GET /support-api/embed.js` (the built piece, cacheable, versioned by content hash); `GET /support-api/config` → `{ product: { id, name }, types, categories, turnstileSiteKey, maxAttachments: 10, maxVideoSeconds: 30 }`; `POST /support-api/tickets` body `{ email, subject (≤ 150), category ('question'|'bug'|'account'|'payment'|'other'), message (≤ 10,000), fields, attachmentIds, turnstileToken }`: Turnstile (with the forwarded client IP), rate limits (5/email/h, 20/client-IP/h), create ticket `open`, attach completed uploads of this product, send the confirmation email (Task 7) linking to `<ticket_page_url>#t=<token>` → `{ ticketLink, emailSent }`.
- The piece: `<shydesk-support view="contact" lang="...">` in a shadow root, colours and fonts from `--shydesk-*` custom properties, calls only relative `/support-api/...` URLs; on success shows the private link (and, when `emailSent` is false, "The email could not be sent. Keep this link to follow the request.").
- `demo-host/`: a tiny Worker on the Non-Prod account (`shydesk-demo.<nonprod-subdomain>.workers.dev`) serving a test support page and forwarding `/support-api/*` exactly as `docs/forwarding.md` describes; it is the reference Cloudflare forwarder, and `examples/forward-node.ts` is the Node one. Both strip any incoming `X-ShyDesk-*` header before adding their own.
- [ ] **Step 1:** Unit tests: no key, an unknown key and a revoked (rotated) key → 404; a valid key without `X-ShyDesk-Client-IP` → 400; the product comes from the key even when the body names another; missing/oversized fields refused with field-level messages; a 6th ticket from one email within the hour refused; a failed Turnstile refused; the token is 43 base64url chars and only its hash is stored; the ticket link is `ticket_page_url` + `#t=` + token; an `attachmentId` that is another product's, still `pending`, or already on another ticket is refused. Both reference forwarders: a browser-sent `X-ShyDesk-Forward-Key` is dropped and replaced. Copy test: every string the piece shows contains none of the banned words (Global Constraints). Expect FAIL, implement, PASS.
- [ ] **Step 2:** e2e on the demo host at phone and desktop sizes: real typing and clicks submit a ticket (Turnstile test keys on Non-Prod), the piece shows the private link; a direct `fetch` to the ShyDesk workers.dev `/support-api/config` gets 404. Commit.

### Task 6: Attachment uploads and server checks

**Files:**
- Create: `src/uploads/routes.ts`, `src/uploads/sniff.ts`, `src/uploads/mp4.ts`, `src/storage.ts`, tests under `tests/unit/`, fixtures `tests/fixtures/{ok-10s.mp4,long-45s.mp4,fake.mp4,photo.jpg,photo.webp}`

**Interfaces:**
- Produces (all under `requireForward`, so the product comes from the forward key): `POST /support-api/uploads` body `{ kind: 'image'|'video', bytes: number, mime: string }` → `{ id, partSize: 8388608, parts: number, thumbId }` (starts an R2 multipart upload through the `FILES` binding and records `r2_upload_id`); `PUT /support-api/uploads/:id/parts/:n` raw bytes, `Content-Length` required, ≤ 8 MB, every part but the last exactly `partSize` → `{ etag }`; `PUT /support-api/uploads/:thumbId` (thumbnail, ≤ 1 MB, single request); `POST /support-api/uploads/:id/complete` → `{ ok: true }` or 422 `{ error }`; `sniff(head: Uint8Array): 'jpeg'|'webp'|'mp4'|null`; `mp4DurationMs(head: Uint8Array): number | null` (reads `moov/mvhd` timescale and duration, version 0 and 1); `storedBytes(db)`, `addStored(db, n)`.
- Server rules: no size limit per file (only the 30 s length); ≤ 10 per message; refuse at start when `storedBytes + bytes > FREE_STORAGE_BYTES` with "Storage for attachments is full right now. Please send the message without attachments." An upload id of another product is 404. `complete` finishes the multipart upload, checks the stored size equals the declared size, reads the first 64 KB (and, if `moov` is at the end, the last 64 KB), sniffs content, checks duration ≤ 30,000 ms, then marks `stored` and adds bytes; any failure deletes the object and returns 422. An upload still `pending` 1 hour after start is aborted the next time any upload starts for that product (no clock), and the admin desk's overdue panel (Task 12) lists any older one.
- [ ] **Step 1:** Unit tests with the fixtures and a mocked R2 binding: `sniff` names each and returns null for `fake.mp4`; `mp4DurationMs` returns ~10,000 for `ok-10s.mp4` and ~45,000 for `long-45s.mp4`, and null for a truncated box; `complete` refuses `long-45s.mp4` and `fake.mp4` and deletes them; a part over 8 MB, a short middle part and a part for another product's upload are refused; storage at 99.9 % refuses a start that would pass `FREE_STORAGE_BYTES` before any part is accepted, and a 300 MB 30-second video (38 parts) is accepted when storage has room. Expect FAIL, implement, PASS.
- [ ] **Step 2:** Integration (CI, Non-Prod R2 through the demo host): a 3-part upload completes and the object's size matches; a part sent straight to the ShyDesk workers.dev host without the forward gets 404. Commit.

### Task 7: No-reply email

**Files:**
- Create: `src/mail/oci.ts`, `src/mail/notify.ts`, tests under `tests/unit/`

**Interfaces:**
- Produces: `signOciRequest(req: Request, keys: OciKeys): Promise<Request>` (OCI HTTP signature, RSA-SHA256, headers `date (request-target) host content-length content-type x-content-sha256`); `sendNoReply(env, product: Product, to: string, kind: 'created'|'reply', link: string): Promise<'sent'|'share-used-up'|'failed'>`.
- Copy (fixed): subject "Your support request: something new"; body "There is a new update on your support request. Open it here: <link>" plus the product name; no reply text, ever. Counts against `counters['mail:<product>:<YYYY-MM>']`; at the product's share returns `share-used-up` without calling OCI.
- [ ] **Step 1:** Unit tests: the signature header matches a known vector (from OCI's documented example key); a used-up share never calls `fetch`; a non-2xx from OCI returns `failed` and the caller shows the private link on screen with "The email could not be sent. Keep this link to follow the request." Expect FAIL, implement, PASS. Commit.

### Task 8: Browser compression and upload in the shared piece

**Files:**
- Create: `public/src/embed/compress-image.ts`, `public/src/embed/compress-video.ts`, `public/src/embed/uploader.ts` (sends parts in order through the forward, one at a time, and shows progress), `tests/unit/compress-plan.test.ts`, `tests/e2e/upload.spec.ts`

**Interfaces:**
- Produces: `planImage(w: number, h: number): { w: number; h: number; quality: 0.85 }` (long edge ≤ 2560, aspect kept, never upscaled); `planVideo(w: number, h: number, fps: number): { w: number; h: number; fps: number; bitrate: 5_000_000 }` (long edge ≤ 1920, even dimensions, aspect kept, fps ≤ 30, never upscaled); `pickSmaller(original: Blob, compressed: Blob | null): Blob`; `compressImage(file: File): Promise<Blob>` (OffscreenCanvas `convertToBlob({ type: 'image/jpeg', quality: 0.85 })`); `compressVideo(file: File): Promise<Blob | null>` (WebCodecs decode via `mp4box`, encode H.264 High profile `avc1.640028` at the planned size + AAC 128 kbit/s, mux with `mp4-muxer`; returns null when `VideoEncoder` is missing or the config is unsupported, and the original is uploaded); thumbnails: image → 320 px JPEG, video → first frame 320 px JPEG.
- The piece checks duration in the browser first (≤ 30 s) and says "Videos can be up to 30 seconds long." before any upload.
- [ ] **Step 1:** Unit tests for `planImage` and `planVideo` (4000×3000 → 2560×1920; 640×480 unchanged; 3840×2160 at 60 fps → 1920×1080 at 30 fps; portrait 2160×3840 → 1080×1920; an odd result rounds to even; `pickSmaller` returns the original when the compressed blob is larger or null). Expect FAIL, implement, PASS.
- [ ] **Step 2:** e2e on the demo host (Chromium and WebKit in CI): real file chooser with `photo.jpg` and `ok-10s.mp4` uploads both and the stored sizes are smaller than the originals; `long-45s.mp4` shows the 30-second message. Real-phone check (Android and iOS, camera roll) is on the release checklist (Task 14). Commit.

### Task 9: Customer ticket view in the shared piece

**Files:**
- Create: `src/customer/ticket.ts`, `public/src/embed/ticket-view.ts`, tests under `tests/unit/`, `tests/e2e/customer-ticket.spec.ts`

**Interfaces:**
- Consumes: `requireForward`, `createTicket` token hashing, uploads, `sendNoReply`.
- `<shydesk-support view="ticket">` reads the token from `location.hash` (`#t=<token>`) and sends it as `Authorization: Ticket <token>`; never in a path or query. `GET /support-api/ticket` → thread and attachments (thumbnails; full view in the same viewer as Task 11, read-only, files streamed by `GET /support-api/files/:attachmentId` with the same header). `POST /support-api/ticket/reply`: message plus attachments; sets status `open`; a closed ticket reopens and its timers are cancelled (Task 12). Unknown or deleted token, or a token whose ticket belongs to another product than the forward key's: 404, and the piece shows "This link is no longer valid." Removed attachments show "Attachment removed after 30 days."
- [ ] **Step 1:** Unit tests: token lookup by hash only; a valid token through another product's forward → 404; reply on `closed` → `open` and calls `timer.cancel`; reply on `waiting` → `open`; attachments in `deleted` state render the removed line. Expect FAIL, implement, PASS.
- [ ] **Step 2:** e2e on the demo host: open the link from a created ticket, reply with real typing and an attachment via the real file chooser. Commit.

### Task 10: Staff desk: list, switcher, badge, ticket view, reply

**Files:**
- Create: `src/desk/routes.ts`, `src/desk/views.tsx`, `src/desk/queries.ts`, `public/src/desk.ts`, tests under `tests/unit/`, `tests/e2e/desk.spec.ts`

**Interfaces:**
- Consumes: `requireStaff`, `scope`, `sendNoReply`, canned replies.
- Produces: `listTickets(db, products: string[], f: { status?; type?; cursor? })` (waiting-on-staff first, oldest first); `getTicket(db, products, id)` (null when out of scope → 404); `reply(db, staff, ticketId, body)` (status → `waiting`, email `reply`, starts the 7-day auto-close timer); `close(db, staff, ticketId)` (status `closed`, starts retention timers); `unreadCount(db, email, products)`.
- Product switcher: rep sees granted products only; admin also "All products". Badge: `public/src/desk.ts` polls `GET /desk/api/unread` every 30 s only while the tab is visible (`document.visibilityState`), stops when hidden.
- Canned replies: the reply box has a picker listing the product's (and type's) canned replies; choosing one inserts its body with `{{customer_email}}` and `{{ticket_subject}}` filled; the rep edits before sending.
- [ ] **Step 1:** Unit tests: a rep for `shytalk` gets null for a `yawelo-idle` ticket and an empty list for `?product=yawelo-idle`; ordering; reply sets `waiting` and calls the timer; placeholders fill and unknown placeholders stay as typed. Expect FAIL, implement, PASS.
- [ ] **Step 2:** e2e: rep signs in (Access service token for CI), switches product, opens a ticket, picks a canned reply with real clicks, edits by typing, sends; the customer page shows the reply. Commit.

### Task 11: Media viewer

**Files:**
- Create: `public/src/viewer.ts`, `public/viewer.css`, `tests/unit/viewer-state.test.ts`, `tests/e2e/viewer.spec.ts`

**Interfaces:**
- The viewer module is used by both the staff desk and the shared piece's ticket view (bundled into `embed.js`); in the piece it loads files from `/support-api/files/:attachmentId`.
- Produces: pure state `type ViewerState = { index: number; zoom: number; rotation: 0|90|180|270; panX: number; panY: number }` with `zoomBy(s, factor, cx, cy)`, `rotate(s, dir: 1|-1)`, `next(s, count)`, `prev(s, count)`; zoom clamped 1–8.
- Attachments section of thumbnails (video: frame + `m:ss` length). Clicking opens an overlay: zoom (wheel, pinch, + / − buttons), rotate (buttons, `r`), next/previous (arrows, swipe), `Esc` closes; video gets native controls (play/pause, scrub). Files are served through `GET /files/:attachmentId` (scope-checked, `Content-Disposition: inline`, no write route exists).
- [ ] **Step 1:** Unit tests for the state functions (clamps, wrap-around on next/prev, rotation cycles). Expect FAIL, implement, PASS.
- [ ] **Step 2:** e2e with real wheel, keyboard and touch: zoom to 2×, rotate twice, next, `Esc`. Commit.

### Task 12: Ticket timers (expiry without a clock)

**Files:**
- Create: `src/timers/ticket-timer.ts` (Durable Object class `TicketTimer`), `src/timers/client.ts`, `src/desk/overdue.ts`, tests under `tests/unit/`

**Interfaces:**
- Produces: `timer(env, ticketId)` with `schedule(kind: 'autoclose'|'attachments'|'text', at: number)`, `cancel(kinds?: Kind[])`; the DO stores each kind's due time in its storage and sets the alarm to the earliest. On `alarm()`: reloads the ticket; `autoclose` closes if still `waiting` and schedules retention; `attachments` deletes R2 objects and marks rows `deleted` if still `closed` (Release 2 adds the hold check here); `text` deletes messages and the ticket row if still `closed`; reschedules any remaining kind. `overdue(db, now)`: items past their due date still stored, and uploads still `pending` more than 1 hour after start (Task 6) (computed at page load, shown on the admin desk). The same admin panel shows "Attachment storage at N % of the free 10 GB" once `storedBytes ≥ 80 %` of `FREE_STORAGE_BYTES` (Task 6), with a test at 79.9 % (hidden) and 80 % (shown).
- [ ] **Step 1:** Unit tests with a mocked DO storage and clock: close schedules `attachments` at +30 d and `text` at +365 d (from the product's keep-days); reopen cancels both; an alarm firing for a ticket reopened in between does nothing; `overdue` lists an attachment whose due time passed. Expect FAIL, implement, PASS. Commit.

### Task 13: Product API: feed and OpenAPI

**Files:**
- Create: `src/api/routes.ts`, `src/api/auth.ts`, `openapi/shydesk.v1.yaml`, `public/api-docs/` (self-hosted `swagger-ui-dist`), `tests/unit/api-auth.test.ts`, `tests/contract/openapi.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/products/{product}/feed?since_cursor=<int>&limit=<1..100>` → `{ items: TicketSummary[], next_cursor: number }` ordered by `seq`; `Authorization: Bearer <key>`, key's product must equal `{product}` else 404. Docs at `/api/docs` behind Access, covering both `/api/v1/*` (product servers, direct to workers.dev) and `/support-api/*` (the shared piece, through the forward), with `docs/forwarding.md` linked.
- [ ] **Step 1:** Unit tests: unknown, revoked and other-product keys → 401/404; cursor paging returns each change once. Contract test: every route the app registers under `/api/v1` and `/support-api` is in the spec and every response validates against it. Expect FAIL, implement, PASS. Commit.
- [ ] **Step 2:** Send the ShyTalk, shyden.co.uk and Yawelo Idle sessions the spec path, `docs/forwarding.md`, the embed snippet, and the secret NAMES of their dev forward key and API key.

### Task 14: Release

- [ ] **Step 1:** Configure products on live: `shyden-co-uk`, `yawelo-idle`, `shytalk` with sender addresses, ticket page URLs and shares (Shyden confirms each); give each product its live forward key through its own production secret store.
- [ ] **Step 2:** The e2e journey suite runs once on the release cut in CI.
- [ ] **Step 3:** Real Android and iOS phones: open each product's own support page (the shared piece behind its forward), attach a camera-roll photo and a 25 s video, submit, open the private link from the email, reply. Shyden signs off.
- [ ] **Step 4:** Privacy-policy text for each product: what ShyDesk stores, 30 days for attachments, 1 year for text, Oracle's handling of email content (from Task 0). Then the release cut to `main` (Shyden approves production).
