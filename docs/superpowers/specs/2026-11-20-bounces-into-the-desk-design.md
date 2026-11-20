# Bounced notices shown in the desk: design

Ticket: shyden-labs/shydesk#232. Date: 2026-11-20.

## Why

On 2026-11-20 a Yawelo Idle notice was accepted by its mail server and then refused one hop later by Sparked Host's outgoing filter (MailBaby). The only trace was a bounce in a no-reply mailbox nobody reads, found by hand 4 hours later (shyden-labs/shydesk#228). A customer who never gets their notice should not go unnoticed. Shyden ruled that bounces go **into the ShyDesk desk**, beside the customer's ticket, and that ShyDesk receives them through **a bounce address on its own domain**, with forwarders as the fallback (both 2026-11-20).

## Goals

- When a notice to a customer bounces, the ticket in the desk shows it within minutes: when, the address, and the receiving server's reason.
- The ticket list marks tickets whose latest notice bounced, so staff spot them without opening each one.
- Works the same for every product and sender server.

## Non-goals

- Retrying, or switching to another delivery route, automatically.
- Showing the customer anything about the bounce.
- Reading anything other than delivery failure reports (auto-replies, spam and the like are dropped).

## Anti-goals

- A forged report can mark a ticket. A report must name an address only ShyDesk could have handed out.
- Normal mail starts failing because of the new sender address. Gate 0 below proves this first, on every sender server.

## Constraints

- ShyDesk is a Cloudflare Worker. Cloudflare can hand incoming mail to a Worker only for a domain whose mail it receives (Email Routing), and only within the same account. Live has `shydesk.dpdns.org` (ShyDesk account). The Non-Prod Worker runs on workers.dev and has no domain.
- Sender servers: web-par-01 (cPanel Exim: shyden.co.uk, shytalk.app) and web-par-03 (Athena Postfix: yaweloidle.com). Mail to outside addresses leaves through MailBaby (account mb82350). MailBaby's docs say it refuses senders from domains the account isn't authorised for, and asks for the Header From and the envelope sender to be aligned.
- DMARC still passes without that alignment: each server signs the message with the From domain's DKIM key (measured in the 2026-11-20 headers, `d=shyden.co.uk` and `d=yaweloidle.com`).
- Ticket text is deleted on schedule (migration 0005). Bounce details hold the customer's address, so they go with it.

## Approaches

1. **Bounce address on ShyDesk's domain (picked by Shyden).** The SMTP envelope sender (`MAIL FROM`) becomes `bounce-<notice id>@<bounce domain>`. The visible From stays the product's no-reply address. Failure reports go straight to Cloudflare, which passes them to the Worker. Nothing to set up per mailbox, and the notice id in the address does the matching. Risk: a server or MailBaby may refuse a sender domain that isn't the mailbox's own, which Gate 0 settles.
2. **Forwarders (the fallback).** Each no-reply mailbox forwards to a ShyDesk address, and the notice carries a header naming its notice id. Used for any sender server that refuses approach 1, after asking Shyden.
3. **Daily mailbox check.** Not chosen: a clock job, a mail-reading client, and up to a day late.

## Design

### Gate 0: prove the servers accept it (before any product code)

A dev build sends, from each sender server (shyden.co.uk, shytalk.app, yaweloidle.com), one notice with the new envelope sender to (a) an outside mailbox and (b) an address that doesn't exist at an outside domain. Pass means (a) arrives with `X-MAILBABY-ORIGIN: PASS`, and (b)'s failure report reaches the Worker. Any server that fails goes to Shyden with the forwarder fallback for that server.

### Domains and records

- **Live:** Email Routing on `shydesk.dpdns.org`, catch-all to the `shydesk` Worker. SPF on that domain: `v=spf1 include:spf-c.mailbaby.net ip4:45.43.163.116 ip4:45.43.163.10 ~all` (both sender servers plus MailBaby). This changes the production zone, so it waits for Shyden's approval.
- **Dev:** a second free dpdns name in the ShyDesk Non-Prod account, with the same records, routed to the Non-Prod Worker. Registering it is Shyden's call (see Open for Shyden).
- New setting `BOUNCE_DOMAIN` per environment. Without it, sends keep today's envelope sender and nothing changes.

### Sending

- New table `notices (id TEXT PRIMARY KEY, ticket_id, message_id NULL, to_address, sent_at, bounced_at NULL, bounce_status NULL, bounce_reason NULL)`. The id is random (a UUID): unguessable, so it can't be forged. `message_id` names the staff reply the notice was about, and is null for the new-ticket notice (builder's call: so the desk can show the bounce line under the right message).
- `notifyCustomer` inserts the row before sending and passes `bounce-<id>@BOUNCE_DOMAIN` as the envelope sender. `MAIL FROM` uses it; the `From:` header stays the product's address. The SMTP client gets a separate `envelopeFrom` field.
- A failed send deletes its row (alongside the existing share give-back).

### Receiving

- The Worker gains an `email()` handler. Recipients that don't match `bounce-<uuid>@BOUNCE_DOMAIN`, or that name an unknown or already-bounced notice, are rejected (`setReject`), and nothing is stored.
- Only a delivery status report counts: `Content-Type: multipart/report; report-type=delivery-status` with `Action: failed`. From it the handler records `Status` and `Diagnostic-Code`, cut to 500 characters. Anything else (auto-replies, delays with `Action: delayed`) is dropped.
- Parsing is a small in-house reader for those few fields, unit-tested on real reports: the MailBaby bounce and an Exim bounce, kept as fixtures with addresses replaced.

### Desk

- Ticket page: under the message the notice was about, the line "Email to <address> bounced at <time>: <reason>".
- Ticket list: an "Email bounced" marker when the ticket's latest notice bounced.
- No new staff action.

### Retention

When a ticket's text is deleted, its `notices` rows are deleted with it (inside the existing deletion step).

## Open for Shyden

1. The dev domain: register a second dpdns name (for example `shydesk-dev.dpdns.org`) for the Non-Prod account? This is an account-level step done in his dpdns login.
2. The live records (Email Routing and SPF on `shydesk.dpdns.org`) are a production change: approved at the release that ships this.

## Left to the builder

The SQL migration's exact shape, file layout, the parser's structure, and the test fixtures, within the repository's existing conventions (strict TDD, unit tests mocked, real-database checks in `tests/integration/`).
