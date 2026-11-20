# Bounced notices shown in the desk: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A notice that bounces shows on its ticket in the desk within minutes, with when, the address and the server's reason, and the ticket list marks it.

**Architecture:** Each notice gets a row in a new `notices` table and is sent with the envelope sender `bounce-<notice id>@BOUNCE_DOMAIN`. Cloudflare Email Routing on that domain hands failure reports to the Worker's new `email()` handler, which records the bounce on the matching row. The desk reads the rows.

**Tech Stack:** Cloudflare Workers (Hono), D1, Email Routing, Vitest (unit mocked, `tests/integration/` on real D1).

**Spec:** `docs/superpowers/specs/2026-11-20-bounces-into-the-desk-design.md` (shyden-labs/shydesk#232).

## Global Constraints

- Dev bounce domain: `shydeskdev.dpdns.org` (ShyDesk Non-Prod account 5bf57d1deff03bfbb596674c1bdb30d4, zone active 2026-11-20 13:11 UTC). Live: `shydesk.dpdns.org`, changed only with Shyden's approval at the release.
- SPF on each bounce domain, one record: `v=spf1 include:_spf.mx.cloudflare.net include:spf-c.mailbaby.net ip4:45.43.163.116 ip4:45.43.163.10 ~all`. Email Routing's own include must stay in it: with MailBaby's alone, Email Routing marks the domain's records misconfigured (measured on dev 2026-11-21, shyden-labs/shydesk#232).
- Without `BOUNCE_DOMAIN`, sending is exactly today's: `MAIL FROM` is the product's address and no `notices` row is written.
- The notice id is `crypto.randomUUID()`. The recipient pattern is `^bounce-([0-9a-f-]{36})@<BOUNCE_DOMAIN>$`, case-insensitive.
- Only `multipart/report; report-type=delivery-status` with `Action: failed` counts. `Status` and `Diagnostic-Code` are cut to 500 characters.
- Ticket page copy, fixed: `Email to <address> bounced at <time>: <reason>`. List marker, fixed: `Email bounced`.
- Strict TDD on every task: the test runs red before its code. Unit tests mock D1; real-database checks go in `tests/integration/`. Write ticket refs as `shyden-labs/shydesk#N`.
- Never `Closes`/`Fixes` next to an issue number: `Refs shyden-labs/shydesk#232`.

## Review Focus

1. **A report for a notice whose ticket text was already deleted:** rejected, nothing stored (the row went with the text). Test in Task 4.
2. **A second report for the same notice** (MailBaby and the far server both reporting): the first one wins and the second is rejected. Test in Task 4.
3. **Mixed-case recipient** (`Bounce-ABC…@ShydeskDev.dpdns.org`, some servers upper-case it): still matched. Test in Task 4.
4. **A `Diagnostic-Code` folded over several lines, or one over 500 characters:** unfolded to one line, then cut. Test in Task 3.
5. **The send fails after the row was inserted:** the row is deleted with the share give-back, so the desk never shows a notice that never left. Test in Task 2.

---

### Task 0: Plan docs commit

**Files:**
- Modify: `docs/superpowers/specs/2026-11-20-bounces-into-the-desk-design.md` (dev domain line and Open-for-Shyden item 1)
- Create: this plan

- [ ] **Step 1:** In the design, replace `shydesk-dev.dpdns.org` with `shydeskdev.dpdns.org` and mark Open-for-Shyden item 1 resolved: "Registered 2026-11-20 (DigitalPlat, renew by 2027-11-20), zone active in ShyDesk Non-Prod."
- [ ] **Step 2:** One docs commit, one PR into `develop`, merged once CI is green on its head.

### Task 1: SMTP envelope sender

**Files:**
- Modify: `src/mail/smtp.ts` (`SmtpMail`, `checkInput`, the `MAIL FROM` command at line 117)
- Test: `tests/unit/smtp.test.ts`

**Interfaces:**
- Produces: `SmtpMail.envelopeFrom?: string`. When set, `MAIL FROM:<envelopeFrom>`; the `From:` header always stays `from`.

- [ ] **Step 1: Failing tests** in `tests/unit/smtp.test.ts`:
  - `uses envelopeFrom for MAIL FROM and keeps From: as the sender`: the written commands contain `MAIL FROM:<bounce-1@bounce.example>` and the data contains `From: noreply@product.example`.
  - `uses from for MAIL FROM when envelopeFrom is absent`: `MAIL FROM:<noreply@product.example>`.
  - `refuses an envelopeFrom with a line break or that is not a plain address`: `SmtpError` with code `input` and message `envelopeFrom holds a line break` / `envelopeFrom is not a plain address`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/smtp.test.ts`; the three fail.
- [ ] **Step 3:** Add the field; `checkInput` checks it with the same two rules when present.
- [ ] **Step 4:** Run again: pass. Mutate the `MAIL FROM` line back to `mail.from` and watch the first test fail, revert in the same call.
- [ ] **Step 5:** Commit `Send notices with a separate envelope sender (Refs shyden-labs/shydesk#232)`.

### Task 2: `notices` table and the bounce address on every notice

**Files:**
- Create: `migrations/0006_notices.sql`
- Modify: `src/mail/notify.ts`, `src/desk/routes.ts` (reply route ~line 304 and `notifyCustomer`), `src/customer/contact.ts:175`, `src/customer/appeal.ts:80`, `src/timers/retention.ts` (`deleteText` batch), `wrangler.jsonc` (`BOUNCE_DOMAIN` in the dev env's `vars` only)
- Test: `tests/unit/notify.test.ts`, `tests/unit/retention.test.ts`, `tests/integration/mail-share.test.ts`, `tests/integration/schema.test.ts`, `tests/unit/wrangler-config.test.ts`

**Interfaces:**
- Consumes: `SmtpMail.envelopeFrom` (Task 1).
- Produces:
  - Table `notices (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets (id), message_id TEXT, to_address TEXT NOT NULL, sent_at INTEGER NOT NULL, bounced_at INTEGER, bounce_status TEXT, bounce_reason TEXT)` plus `CREATE INDEX notices_ticket ON notices (ticket_id, sent_at)`.
  - `MailEnv.BOUNCE_DOMAIN?: string | undefined`.
  - `sendNoReply(env, product, to, link, deliver, now, about: { ticketId: string; messageId: string | null })`. `about` is the new last parameter; `now` loses its default (every caller passes it).

- [ ] **Step 1: Failing tests** in `tests/unit/notify.test.ts`:
  - `with BOUNCE_DOMAIN, inserts a notice row before delivering and sends from bounce-<id>@domain`: the mocked D1 sees `INSERT INTO notices` with `(id, 't1', 'm1', to, now)` before `deliver` is called, and `deliver` gets `envelopeFrom` `bounce-${id}@bounce.example` where `id` is the inserted one; `from` is the product's address.
  - `without BOUNCE_DOMAIN, writes no row and sets no envelopeFrom`.
  - `a failed send deletes its notice row and gives the share back` (Review Focus 5).
  - `a used-up share writes no row`.
- [ ] **Step 2:** Failing test in `tests/unit/retention.test.ts`: `deleteText deletes the ticket's notices in the same batch, while closed and not held` (the batch holds `DELETE FROM notices WHERE <whileClosed>` before the tickets statements).
- [ ] **Step 3:** Failing integration tests: `schema.test.ts` sees the `notices` columns above; `mail-share.test.ts` `a reply notice row names its message, a new-ticket notice row has message_id null` (real D1, through the contact and reply routes with a stub `deliver`); `wrangler-config.test.ts` `dev sets BOUNCE_DOMAIN to shydeskdev.dpdns.org and live sets none`.
- [ ] **Step 4:** Run `npx vitest run tests/unit/notify.test.ts tests/unit/retention.test.ts tests/unit/wrangler-config.test.ts`; all new ones fail. (Integration runs in CI.)
- [ ] **Step 5:** Implement. Callers pass `{ ticketId, messageId }`: contact and appeal take the `id` that `createTicket` / `createAppeal` already return and `messageId: null`; the reply route keeps the `crypto.randomUUID()` it inserts and hands it through `notifyCustomer`.
- [ ] **Step 6:** Unit tests pass; `npm run typecheck`, lint, and unit coverage at 100% (`npm run test:unit -- --coverage`).
- [ ] **Step 7:** Commit `Write each notice down and send it from its own bounce address (Refs shyden-labs/shydesk#232)`. PR, CI green, squash-merge to `develop`; dev deploys.

### Task G0: Gate 0 on dev (no receiving code yet)

Proves every sender server accepts the new envelope sender before Task 3 is built. Evidence goes on shyden-labs/shydesk#232 as a comment, one block per server.

- [ ] **Step 1: Records on `shydeskdev.dpdns.org`** (Non-Prod, via the dashboard in Chrome): enable Email Routing (it adds its MX and its own SPF TXT; replace that TXT with the Global Constraints SPF, which keeps Email Routing's include), and a catch-all rule forwarding to the shydesk-no-reply mailbox as a verified destination (verify through Sparked Host webmail). Read back with `dig +short MX shydeskdev.dpdns.org @1.1.1.1` and `dig +short TXT shydeskdev.dpdns.org @1.1.1.1`.
- [ ] **Step 2: Per sender server** (shyden.co.uk and shytalk.app on web-par-01, yaweloidle.com on web-par-03): through the dev contact form for that product, open (a) a ticket whose address is a mailbox we can read (routes in memory `reference-mail-proof-routes`) and (b) one to `no-such-user-<random>@gmail.com`.
- [ ] **Step 3: Pass** means (a)'s raw headers show `Return-Path: <bounce-<uuid>@shydeskdev.dpdns.org>`, `X-MAILBABY-ORIGIN: PASS` and `dmarc=pass`; and (b)'s failure report arrives in shydesk-no-reply addressed to that `bounce-<uuid>`. Save both raw reports (MailBaby's and the far server's) with addresses replaced as `tests/fixtures/bounces/<server>-<source>.eml`.
- [ ] **Step 4:** Any server that fails: stop, ask Shyden (`AskUserQuestion`) with the forwarder fallback for that server. Do not start Task 3 for it.
- [ ] **Step 5:** Switch the catch-all from the forward to the `shydesk` Non-Prod Worker only after Task 3 is deployed to dev.

### Task 3: Delivery report reader

**Files:**
- Create: `src/mail/bounce-report.ts`
- Test: `tests/unit/bounce-report.test.ts`, fixtures from Task G0 Step 3

**Interfaces:**
- Produces: `readBounce(raw: string): { status: string; reason: string } | null`. Null for anything that is not a failed delivery-status report.

- [ ] **Step 1: Failing tests**, one per fixture: each real report gives its exact `Status` (e.g. `5.1.1`) and `Diagnostic-Code` text. Plus:
  - `an auto-reply (text/plain) gives null`; `a report with Action: delayed gives null`; `report-type other than delivery-status gives null`.
  - `a folded Diagnostic-Code is unfolded to one line` and `status and reason are cut to 500 characters` (Review Focus 4).
  - `quoted-printable report part is decoded`, if any fixture uses it.
- [ ] **Step 2:** Run `npx vitest run tests/unit/bounce-report.test.ts`: fail.
- [ ] **Step 3:** Implement: find the boundary from the top `Content-Type`, take the `message/delivery-status` part, unfold header lines, read the per-recipient block's `Action`, `Status`, `Diagnostic-Code` (drop the `smtp;` type prefix). No mail library.
- [ ] **Step 4:** Pass; coverage 100%; commit `Read failed delivery reports (Refs shyden-labs/shydesk#232)`.

### Task 4: `email()` handler records the bounce

**Files:**
- Create: `src/mail/bounces.ts`
- Modify: `src/index.ts` (default export becomes `{ fetch: app.fetch, email: handleBounce }`; keep the named `app` export the tests use)
- Test: `tests/unit/bounces.test.ts`, `tests/integration/bounces.test.ts`, `tests/unit/app-routes.test.ts` / `health.test.ts` if they read the default export

**Interfaces:**
- Consumes: `readBounce` (Task 3); `notices` (Task 2).
- Produces: `handleBounce(message: ForwardableEmailMessage, env: { DB: D1Database; BOUNCE_DOMAIN?: string }, now?: number): Promise<void>`. Records with `UPDATE notices SET bounced_at = ?, bounce_status = ?, bounce_reason = ? WHERE id = ? AND bounced_at IS NULL`; when that changes 0 rows, `setReject('unknown notice')`.

- [ ] **Step 1: Failing unit tests** (mocked message and D1):
  - `a failed report to bounce-<id>@domain records status, reason and time`.
  - `a recipient on another domain, without the bounce- prefix, or with a non-UUID is rejected and nothing is written`.
  - `BOUNCE_DOMAIN unset rejects everything`.
  - `a non-report (readBounce null) is rejected and nothing is written`.
  - `an upper-case recipient is matched` (Review Focus 3).
  - `a raw body over 1 MB is rejected unread` (`message.rawSize`).
- [ ] **Step 2: Failing integration tests** (real D1): `a second report for the same notice is rejected and the first stays` (Review Focus 2); `a report for a notice whose ticket text was deleted is rejected` (Review Focus 1, through `deleteText`).
- [ ] **Step 3:** Run the unit file: fail. Implement. Pass; coverage 100%.
- [ ] **Step 4:** Commit `Record failed delivery reports on their notice (Refs shyden-labs/shydesk#232)`; PR, green, merge; dev deploys. Then Task G0 Step 5 (catch-all to the Worker), and resend (b) for each server: `npx wrangler d1 execute` on dev (read-only `SELECT bounced_at, bounce_status FROM notices WHERE id = ?`) shows each bounce within 5 minutes. Evidence on the ticket.

### Task 5: Desk shows bounces

**Files:**
- Modify: `src/desk/queries.ts` (`getTicket` returns `notices`; `listTickets` adds `last_notice_bounced`), `src/desk/views.ts` (`ticketPage`, `listPage`)
- Test: `tests/unit/desk-views.test.ts`, `tests/integration/desk.test.ts`

**Interfaces:**
- Consumes: `notices` (Task 2).
- Produces: `DeskNotice { message_id: string | null; to_address: string; bounced_at: number; bounce_reason: string; bounce_status: string }` (bounced rows only); `TicketData.notices: DeskNotice[]`; `DeskTicket.last_notice_bounced: 0 | 1` from `(SELECT bounced_at IS NOT NULL FROM notices n WHERE n.ticket_id = tickets.id ORDER BY sent_at DESC, rowid DESC LIMIT 1)`.

- [ ] **Step 1: Failing view tests:** `a bounced reply notice shows "Email to a@b.example bounced at <when()>: 550 5.1.1 user unknown" inside that message's article`; `a bounced new-ticket notice (message_id null) shows under the first message`; `a reason falls back to the status when empty`; `the list shows "Email bounced" only when the latest notice bounced`, and not when a later notice was sent fine. Copy is escaped (a reason holding `<script>` renders as text).
- [ ] **Step 2: Failing integration test** in `desk.test.ts`: a reply, its notice bounced via `handleBounce`, then `GET /desk/tickets/:id` and `GET /desk` show the line and the marker (soft assertions in one journey).
- [ ] **Step 3:** Run the unit file: fail. Implement. Pass; coverage 100%.
- [ ] **Step 4:** Commit `Show bounced notices on the ticket and in the list (Refs shyden-labs/shydesk#232)`; PR, green, merge. On dev, open the Task 4 bounced ticket in the desk in Chrome and screenshot the line and the marker for the ticket.

### Task 6: Live (Shyden's approval)

- [ ] **Step 1:** At the release that ships Tasks 1–5, ask Shyden to approve: Email Routing catch-all to the `shydesk` Worker and the SPF TXT on `shydesk.dpdns.org`, and `BOUNCE_DOMAIN: "shydesk.dpdns.org"` in live `vars` (with the `wrangler-config` test changed first).
- [ ] **Step 2:** After the release, one live notice per sender server to a readable mailbox shows the bounce envelope with `X-MAILBABY-ORIGIN: PASS`. Evidence on the ticket, then close by hand.
