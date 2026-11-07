# ShyDesk Release 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ShyDesk Release 2: product servers send reports, reps apply each product's punishments through a signed callback, banned users appeal to the admin, and any rep can put a legal hold on evidence that the retention timers then never delete.

**Architecture:** The same single Worker, D1 database and per-ticket Durable Object timers as Release 1. Reports and appeals are tickets of kind `report` and `appeal` (the kinds Release 1's schema already allows), and one migration adds the tables around them. Punishments leave ShyDesk only as a signed HTTPS POST to the product's callback. Holds are rows that the retention code checks before it deletes anything.

**Tech Stack:** As Release 1: TypeScript, Hono, D1, R2, Durable Objects, Access, `jose`; Web Crypto `HMAC`/`SHA-256` for signing (no new package).

**Spec:** `docs/superpowers/specs/2026-11-03-shydesk-v1-design.md`, sections "Release 2 in detail", "Roles", "Retention" and "API". Read the spec and the Release 1 plan (`docs/superpowers/plans/2026-11-03-shydesk-release-1.md`) with this plan: Release 2 consumes Release 1's interfaces, named in each task's Interfaces block.

**Stories:** filed with this plan on ShyDesk Stories (numbers added after filing). Release 2 starts after Release 1's launch (shyden-labs/shydesk#27).

## Global Constraints

- Everything in the Release 1 plan's Global Constraints still applies: free tier only, no scheduled jobs or cron, no email to staff, neutral customer copy, permissive licences, exact versions, D1 `apac`, unit tests mock-only and under 1 s, isolation in SQL on every query, and no silent retries.
- **The product's server, never its app,** calls `/api/v1/*` with its product API key. ShyDesk treats `reporter_id` as asserted by that server.
- The reporter gets "received" from the app and nothing more. ShyDesk never tells a reporter the outcome (spec: later).
- History is **per product only**: a report's history never shows another product's reports or punishments.
- Callback signature (agreed with the ShyTalk session): `HMAC-SHA256(secret, timestamp + "." + rawBody)`, hex. The product rejects a timestamp more than **5 minutes** off. Sending is idempotent on ShyDesk's punishment ID. The product answers `200 {"applied": true, ...}` or `4xx/5xx {"error": "<code>"}`.
- A failed callback is shown on the ticket and is never retried by ShyDesk. A person may press "Send again", which re-sends the same punishment ID.
- Only the admin lifts a ban, sees appeals (a rep never sees one, not even a count), lifts a legal hold, or records a report to the authorities.
- **One appeal per punishment.** Once rejected, no further appeal is accepted.
- Held items are never deleted automatically. A hold cannot be lifted before its earliest release date, even by the admin.
- Minimum keeps (spec, builder proposal pending the lawyer check): possible crime not yet reported: until the admin reports it or records why no report is needed; reported to authorities: **365 days** from the report date; law-enforcement preservation request: **90 days** from the request, **+90** for each renewal, and while a production order is unanswered.
- A hold marked suspected child-abuse material hides the files from every viewer, admin included.
- **Release 2's legal-hold and report-to-authorities features do not go live until the lawyer check is in** (spec). The launch story is blocked by the lawyer-check story.

Values this plan fixes (builder calls the spec left open, each named again where it is used):
- Report rate: **120 per minute per product**, through Release 1's `hit()`.
- Evidence upload grant: valid **15 minutes**, at most **10** files (Release 1's per-message limit).
- Callback timeout: **10 s**. Header names are `ShyDesk-Timestamp` (Unix seconds) and `ShyDesk-Signature` (`v1=<hex>`).
- The signing secret is 32 random bytes, base64url, shown once when the admin creates or rotates it.
- The appeal link is `<product appeal page>#appeal=<token>`. The token is 32 random bytes, base64url, and only its SHA-256 is stored. It sits in the fragment so it never reaches the product's server logs.

## Review Focus

1. A rep for `shytalk` opening a `yawelo-idle` report, or any rep opening an appeal ticket by ID, or a product key for `yawelo-idle` asking for a `shytalk` report: expect 404 every time. Pinned in Tasks 3, 4 and 5.
2. The product's callback hangs for 30 s, answers 500, or answers 200 with `{"applied": false}`: expect the punishment shown as failed with the reason, nothing re-sent until a person presses "Send again", and the same punishment ID on that re-send. Pinned in Task 4.
3. A ticket closed 31 days ago whose attachments timer fires while one attachment is held: expect the held one kept and the rest deleted. Then a text timer on a ticket with a ticket-level hold: expect nothing deleted. Pinned in Task 6.
4. The same appeal link used twice, a rejected appeal followed by a second try, and a token for a lifted punishment: expect one appeal, then a refusal saying an appeal was already made, then a refusal saying the punishment is no longer active. Pinned in Task 5.
5. An admin trying to lift a "reported" hold 364 days after the report date, or closing a child-abuse-hold ticket before recording the authority report: expect both refused, each with the date or step still owed. Pinned in Task 6.

---

### Task 1: Release 2 schema

**Files:**
- Create: `migrations/0002_release_2.sql`
- Modify: `src/db/types.ts`
- Test: `tests/integration/schema.test.ts` (extend), `tests/unit/schema-release-2.test.ts`

**Interfaces:**
- Consumes: Release 1 tables `products`, `tickets`, `attachments`, `staff`.
- Produces: the tables below and their row types `ReportRow`, `PunishmentRow`, `AppealRow`, `LegalHoldRow`, `HoldEventRow`, `AuthorityReportRow` in `src/db/types.ts`.

```sql
ALTER TABLE products ADD COLUMN punishments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN callback_url TEXT;
ALTER TABLE products ADD COLUMN callback_secret TEXT;
ALTER TABLE products ADD COLUMN appeal_page_url TEXT;

CREATE TABLE reports (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets (id),
  product_id TEXT NOT NULL REFERENCES products (id),
  reporter_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  subject_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  context_json TEXT NOT NULL
);
CREATE INDEX reports_subject ON reports (product_id, subject_user_id);

CREATE TABLE punishments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  report_ticket_id TEXT NOT NULL REFERENCES tickets (id),
  subject_user_id TEXT NOT NULL,
  punishment_key TEXT NOT NULL,
  label TEXT NOT NULL,
  duration_seconds INTEGER,
  applied_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  send_state TEXT NOT NULL CHECK (send_state IN ('sending', 'applied', 'failed')),
  send_error TEXT,
  appeal_token_hash TEXT NOT NULL UNIQUE,
  lifted_at INTEGER,
  lifted_by TEXT,
  lift_state TEXT CHECK (lift_state IN ('sending', 'applied', 'failed')),
  lift_error TEXT
);
CREATE INDEX punishments_subject ON punishments (product_id, subject_user_id);

CREATE TABLE appeals (
  punishment_id TEXT PRIMARY KEY REFERENCES punishments (id),
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets (id),
  state TEXT NOT NULL CHECK (state IN ('open', 'upheld', 'rejected')),
  decided_by TEXT,
  decided_at INTEGER
);

CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  attachment_id TEXT REFERENCES attachments (id),
  reason TEXT NOT NULL CHECK (reason IN ('crime_unreported', 'reported', 'preservation')),
  csam INTEGER NOT NULL CHECK (csam IN (0, 1)),
  note TEXT NOT NULL,
  placed_by TEXT NOT NULL,
  placed_at INTEGER NOT NULL,
  basis_at INTEGER,
  renewals INTEGER NOT NULL DEFAULT 0,
  order_pending INTEGER NOT NULL DEFAULT 0 CHECK (order_pending IN (0, 1)),
  no_report_reason TEXT,
  lifted_at INTEGER,
  lifted_by TEXT
);
CREATE INDEX legal_holds_ticket ON legal_holds (ticket_id) WHERE lifted_at IS NULL;

CREATE TABLE legal_hold_events (
  hold_id TEXT NOT NULL REFERENCES legal_holds (id),
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('placed', 'renewed', 'order', 'reported', 'no_report', 'lifted')),
  detail TEXT NOT NULL
);

CREATE TABLE authority_reports (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets (id),
  reported_to TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  reference TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
```

`basis_at` is the report date (`reported`) or the request date (`preservation`), and NULL for `crime_unreported`.

- [ ] **Step 1: Write the failing tests.** `schema-release-2.test.ts` reads the migration text and asserts: every new table above exists; `appeals.punishment_id` is the PRIMARY KEY (one appeal per punishment); `punishments.appeal_token_hash` is UNIQUE; and no Release 1 table is dropped or recreated (only `ALTER TABLE products ADD COLUMN`). The integration test applies 0001 and then 0002 to the dev database's test copy, as `schema.test.ts` already does for 0001, and asserts that a second appeal row for the same punishment fails with a constraint error.
- [ ] **Step 2: Run** `npm run test:unit -- schema-release-2`. Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration and the row types.**
- [ ] **Step 4: Run** `npm run test:unit -- schema-release-2` and `npm run typecheck`. Expected: PASS. Integration runs in CI on the PR.
- [ ] **Step 5: Commit** `feat: Release 2 schema for reports, punishments, appeals and legal holds`.

### Task 2: Product settings for punishments, callback and appeal page

**Files:**
- Modify: `src/products.ts`, `src/admin/routes.ts`, `src/admin/views.ts`
- Test: `tests/unit/products.test.ts`, `tests/unit/admin-routes.test.ts`

**Interfaces:**
- Consumes: Release 1 `saveProduct`, `getProduct`, the admin settings screen (Task 4).
- Produces: `interface PunishmentDef { key: string; label: string; duration_seconds: number | null }`; `validatePunishments(list: PunishmentDef[]): string[]` (key matches `^[a-z0-9-]{1,32}$` and is unique, label 1–60 characters, duration null or 60–31_536_000); `saveCallback(db, productId, url: string, appealPageUrl: string): Promise<void>` (both must be `https:` exact URLs; an `http:` URL or a URL carrying credentials is refused); `rotateSecret(db, productId): Promise<string>` (returns the new secret once); `getPunishments(db, productId): Promise<PunishmentDef[]>`; `reportTypeId(productId) = `${productId}:report`` and `appealTypeId(productId) = `${productId}:appeal`` (the report type's `reasons_json` is the reason list a report must pick from, edited on the same screen; the appeal type is created with the product and has no reasons).

- [ ] **Step 1: Write the failing tests:** `validatePunishments` refuses a duplicate key, `"Ban 7 days"` as a key, a 61-character label, and a duration of 59; it accepts `{ key: 'ban-7d', label: 'Ban 7 days', duration_seconds: 604800 }` and `{ key: 'remove-room', label: 'Remove room', duration_seconds: null }`. `saveCallback` refuses `http://shytalk.app/x` and `https://u:p@shytalk.app/x`. `rotateSecret` returns 43 base64url characters and changes the stored value. Saving report reasons `['Cheating', 'Harassment']` writes ticket type `shytalk:report` with that `reasons_json`; an empty reason list is refused. A rep calling any of the new admin routes gets 404, as with Release 1's admin routes.
- [ ] **Step 2: Run** `npm run test:unit -- products admin-routes`. Expected: FAIL.
- [ ] **Step 3: Implement.** The settings screen gets a punishments list editor, the callback URL, the appeal page URL, and a "Create / rotate signing secret" button that shows the secret once with copy text telling the admin to put it in the product's server secret.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: per-product punishments, callback address and signing secret`.

### Task 3: Reports API, evidence grants and offender history

**Files:**
- Create: `src/reports/create.ts`, `src/reports/history.ts`
- Modify: `src/api/routes.ts`, `openapi/shydesk.v1.yaml`
- Test: `tests/unit/reports.test.ts`, `tests/unit/openapi-contract.test.ts`, `tests/integration/reports.test.ts`

**Interfaces:**
- Consumes: `requireProductKey()` (sets the key's product, 404 when it differs from `{product}`); Release 1 `createTicket(db, input: NewTicket)`, `hit(db, key, limit, windowSeconds)`, and Task 6's upload endpoints (`/support-api/uploads*`), which in Release 1 accept a Turnstile-verified ticket token.
- Produces:
  - `POST /api/v1/products/{product}/upload-grants` with body `{ count: 1..10 }` returns `201 { grant: string, expires_at: number }`. The grant is accepted by Release 1's upload endpoints in place of the ticket token for **15 minutes**. Only its hash is stored, in `counters` under key `grant:<hash>` with `window_start` = expiry and `value` = files remaining.
  - `POST /api/v1/products/{product}/reports` with body `{ reporter_id, item: { kind, id }, subject_user_id, reason, note?, context?, upload_ids?: string[] }` returns `202 { report_id }`. `reason` must be one of the product's report type reasons. `upload_ids` must be stored uploads made under a grant from this product. The ticket is created with kind `report`, status `open`, and subject `"<reason>: <item.kind> <item.id>"`. No email is sent, because there is no customer address.
  - `GET /api/v1/products/{product}/reports/{id}` returns `{ report, history }`.
  - `offenderHistory(db, productId: string, subjectUserId: string, excludeTicketId?: string): Promise<{ reports: { ticket_id: string; reason: string; created_at: number; status: string }[]; punishments: { id: string; label: string; created_at: number; send_state: string; lifted_at: number | null }[] }>`. Both queries filter `product_id = ?` in SQL. Newest first, 50 of each.
  - Rate: `hit(db, 'reports:<product>', 120, 60)`; over the limit returns `429 { error: 'rate_limited' }`.

- [ ] **Step 1: Write the failing tests:** a valid report returns 202, and the recorded statements show one `tickets` insert of kind `report` and one `reports` insert. An unknown reason returns 422 `{ error: 'unknown_reason' }`. A `yawelo-idle` key on `/products/shytalk/reports` returns 404. The 121st report in a minute returns 429. An `upload_id` from another product's grant returns 422 `{ error: 'unknown_upload' }`. A grant used for an 11th file is refused, and so is one used after 15 minutes. `offenderHistory`'s SQL binds the product ID in both queries (read from the D1 stand-in's statements). The OpenAPI contract test lists the three new paths with these status codes.
- [ ] **Step 2: Run** `npm run test:unit -- reports openapi-contract`. Expected: FAIL.
- [ ] **Step 3: Implement** in `src/reports/`, mount the routes in `apiRoutes()`, and extend the OpenAPI spec.
- [ ] **Step 4: Run the same command.** Expected: PASS. `tests/integration/reports.test.ts` runs in CI: a real report on dev, read back through `GET .../reports/{id}`, with an earlier report by the same subject in its history and none from the other product.
- [ ] **Step 5: Commit** `feat: reports API with evidence upload grants and per-product history`.

### Task 4: Punishments with the signed callback

**Files:**
- Create: `src/punishments/sign.ts`, `src/punishments/send.ts`
- Modify: `src/desk/*` (Release 1 Task 10's report view), `openapi/shydesk.v1.yaml` (`webhooks:` section)
- Test: `tests/unit/punishment-sign.test.ts`, `tests/unit/punishment-send.test.ts`, `tests/integration/punishments.test.ts`

**Interfaces:**
- Consumes: Release 1 `getTicket(db, products, id)`, `scope()`; Task 2 `getPunishments`; Task 3 `offenderHistory`.
- Produces:
  - `sign(secret: string, timestamp: number, rawBody: string): Promise<string>` returns `v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`.
  - `verify(secret, timestamp, rawBody, header, now): Promise<boolean>` is false when `|now − timestamp| > 300` s. It compares in constant time. It is shipped so products and tests can check against the same code.
  - `applyPunishment(env, staff, reportTicketId, key): Promise<PunishmentRow>` inserts with `send_state 'sending'` and then calls `send`.
  - `send(env, punishment, type: 'punishment.apply' | 'punishment.lift', fetcher = fetch): Promise<'applied' | 'failed'>`. It POSTs `{ type, punishment_id, product, subject_user_id, punishment: { key, label, duration_seconds }, report_ticket_id, appeal_url?, issued_at }` with headers `ShyDesk-Timestamp` and `ShyDesk-Signature`, aborting after **10 s**. It records `applied` only on HTTP 200 with `applied === true`. Anything else is recorded as `failed` with `send_error` set to `timeout`, `http_<status>` with the product's `error` code, or `not_applied`. It never sends twice by itself.
  - `liftPunishment(env, staff, punishmentId)` is admin-only (404 for a rep). It sets `lifted_at` and `lifted_by` and sends `punishment.lift`.
  - Desk: the report view shows the offender history and a punishment picker (a rep in scope or the admin). Each punishment shows its state, and a "Send again" button appears while it is `failed`.

- [ ] **Step 1: Write the failing tests:**
  - `sign('s3cret', 1762500000, '{"a":1}')` equals the hex computed independently in the test with `node:crypto` `createHmac`.
  - `verify` is true at `now = ts + 300` and false at `ts + 301` and at `ts − 301`.
  - `send` with a fetcher that never resolves records `failed`/`timeout` after the 10 s abort (fake timers).
  - A 500 with `{"error":"user_gone"}` records `http_500 user_gone`.
  - A 200 with `{"applied":false}` records `not_applied`.
  - The fetcher is called exactly once in each case.
  - "Send again" re-sends the same `punishment_id`.
  - A rep lifting gets 404.
  - A rep out of scope applying on another product's report gets 404.
- [ ] **Step 2: Run** `npm run test:unit -- punishment`. Expected: FAIL.
- [ ] **Step 3: Implement.** Document the callback in the OpenAPI `webhooks:` section, with the payload, headers, verification steps and replay rule.
- [ ] **Step 4: Run the same command.** Expected: PASS. Integration in CI: dev's test product has a callback pointing at a dev-only echo route in the Worker that verifies the signature with `verify` and answers `applied`.
- [ ] **Step 5: Commit** `feat: punishments sent to the product through a signed callback`.

### Task 5: Appeals

**Files:**
- Create: `src/appeals/appeals.ts`
- Modify: `src/api/routes.ts`, the customer API (`/support-api/*`, Release 1 Task 5), the shared piece (`appeal` view), `src/desk/*`, `openapi/shydesk.v1.yaml`
- Test: `tests/unit/appeals.test.ts`, `tests/e2e/appeal.e2e.ts`

**Interfaces:**
- Consumes: Task 4's punishments and `liftPunishment`; Release 1 `createTicket`, `requireProductOrigin`, the shared piece's views, and `listTickets`/`getTicket`.
- Produces:
  - Task 4's `punishment.apply` payload carries `appeal_url = <appeal_page_url>#appeal=<token>`.
  - `GET /support-api/appeals?product=<id>` with header `ShyDesk-Appeal: <token>` returns `{ label, created_at, can_appeal: boolean, reason?: 'already_appealed' | 'lifted' }`.
  - `POST /support-api/appeals?product=<id>` with the same header and `{ email, message }` returns `201 { ticket_url }`. That creates a kind-`appeal` ticket and the `appeals` row in one batch. A second POST returns `409 { error: 'already_appealed' }`, and a lifted punishment returns `409 { error: 'lifted' }`.
  - `POST /api/v1/products/{product}/appeals` with `{ punishment_id, email, message }` is the in-product route, with the same rules.
  - `decideAppeal(env, staff, ticketId, outcome: 'upheld' | 'rejected')` is admin-only. `upheld` calls `liftPunishment`.
  - `listTickets` and `getTicket` exclude kind `appeal` unless `staff.role === 'admin'`, in SQL, so no count reaches a rep.
  - The shared piece's `appeal` view reads the token from `location.hash` and never sends it to the product's server.
  - `requireProductOrigin`'s preflight adds `ShyDesk-Appeal` to `Access-Control-Allow-Headers` for the appeals path only.

- [ ] **Step 1: Write the failing tests:**
  - One token used twice: the first gives 201, the second 409 `already_appealed`.
  - After `rejected`, a POST still returns 409 `already_appealed`.
  - A lifted punishment returns 409 `lifted`.
  - An unknown token returns 404.
  - The preflight for `/support-api/appeals` from an allowed origin lists `ShyDesk-Appeal`; from another origin it has no CORS header.
  - A rep calling `getTicket` on an appeal gets null (404). The rep's `listTickets` SQL contains `kind != 'appeal'` and the admin's does not.
  - `upheld` sends exactly one `punishment.lift`.
  - e2e (CI, every target): the piece's appeal view opened with a test token, filled with real typing, and submitted shows the confirmation. A second visit shows "An appeal for this decision was already sent."
- [ ] **Step 2: Run** `npm run test:unit -- appeals`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS. e2e runs in CI.
- [ ] **Step 5: Commit** `feat: one appeal per punishment, admin-only, from the piece or the product`.

### Task 6: Legal holds and the report-to-authorities duty

**Files:**
- Create: `src/holds/rules.ts`, `src/holds/holds.ts`
- Modify: `src/timers/retention.ts`, `src/timers/ticket-timer.ts`, `src/desk/*`, Release 1's attachment-serving route
- Test: `tests/unit/hold-rules.test.ts`, `tests/unit/holds.test.ts`, `tests/unit/retention.test.ts` (extend), `tests/integration/holds.test.ts`

**Interfaces:**
- Consumes: Release 1 `deleteAttachments`, `deleteText`, `timer(env, ticketId).schedule(kind, at)`, `DAY_MS`.
- Produces:
  - `earliestRelease(h: Pick<LegalHoldRow, 'reason' | 'placed_at' | 'basis_at' | 'renewals' | 'order_pending' | 'no_report_reason'>): number | null`. It returns null (cannot be lifted yet) for `crime_unreported` without `no_report_reason`, and for `preservation` with `order_pending`. Otherwise:
    - `reported`: `basis_at + 365 * DAY_MS`;
    - `preservation`: `basis_at + 90 * DAY_MS * (1 + renewals)`;
    - `crime_unreported` with `no_report_reason`: `placed_at`.
  - `placeHold(env, staff, { ticketId, attachmentId?, reason, csam, note, basisAt? })` is open to any rep in scope and the admin. `basisAt` is required for `reported` and `preservation` (`422 { error: 'basis_required' }`), and refused for `crime_unreported`.
  - `renewHold`, `setOrderPending`, `recordAuthorityReport(env, staff, ticketId, { reportedTo, reportedAt, reference })` (turns that ticket's `crime_unreported` holds into `reported` with `basis_at = reportedAt`), `recordNoReport(env, staff, holdId, reason)` and `liftHold(env, staff, holdId, now)` are admin-only. Each writes a `legal_hold_events` row.
  - `liftHold` refuses with `409 { error: 'not_yet', earliest: number | null }` while `now < earliestRelease`. On lift it reschedules that ticket's `attachments` and `text` timers at `max(now, due)` when the ticket is closed, so the admin's lift is the decision and nothing is deleted before it.
  - `heldAttachmentIds(db, ticketId): Promise<Set<string> | 'all'>`.
  - `deleteAttachments` skips held IDs, and `deleteText` does nothing while any hold is active on the ticket, both in SQL (`NOT EXISTS (SELECT 1 FROM legal_holds WHERE lifted_at IS NULL AND ...)`).
  - A `csam` hold (ticket-level, or on that attachment) makes the attachment route answer `404` for every viewer, and the desk shows "Evidence withheld under legal hold".
  - Closing a ticket with an active `csam` hold and no `authority_reports` row is refused with `409 { error: 'authority_report_owed' }`. The admin's desk lists those tickets first, under "Legal duty outstanding", and lists holds past their earliest release under "Holds due for review".

- [ ] **Step 1: Write the failing tests:**
  - `earliestRelease`:
    - `reported` with `basis_at = T` gives `T + 365 d`;
    - `preservation` with 2 renewals gives `T + 270 d`;
    - `preservation` with an order pending gives null;
    - `crime_unreported` gives null.
  - `liftHold` at `T + 364 d` gives 409 `not_yet`, and at `T + 365 d` it succeeds and reschedules both timers.
  - A rep calling `liftHold` gets 404.
  - Retention: the attachments timer on a closed ticket with one held attachment deletes only the others, and the statements' SQL contains the `legal_holds` `NOT EXISTS`. `deleteText` with a ticket-level hold deletes nothing.
  - `placeHold` with reason `reported` and no `basisAt` gives 422 `basis_required`.
  - The attachment route under a `csam` hold gives 404 for the admin.
  - Closing with a `csam` hold and no authority report gives 409 `authority_report_owed`.
- [ ] **Step 2: Run** `npm run test:unit -- hold retention`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS. Integration in CI: a held attachment on dev survives its timer firing (alarm forced through the DO's test hook from Release 1 Task 12).
- [ ] **Step 5: Commit** `feat: legal holds that retention never deletes, and the authority-report duty`.

### Task 7: Lawyer check (Shyden)

Not code. Shyden gets legal advice for Indonesia and the main user countries covering the questions in the spec's "Lawyer check before Release 2 ships". The result is recorded in the spec. Where the advice changes a minimum keep or a duty, `earliestRelease`'s values and their tests change in one PR before the launch.

### Task 8: Release 2 launch

**Blocked by:** Tasks 1–6 and Task 7.

- [ ] Run the E2E journey gauntlet once on every target, as the release's last gate. Shyden signs off on real phones, then the `release/*` cut goes to production with his approval.
- [ ] Send the ShyTalk session the live callback contract (link to the OpenAPI `webhooks:` section), the reports API path and the appeal page requirement.
