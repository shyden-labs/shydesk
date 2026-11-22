# ShyDesk's part of each product's PSE registration

ShyDesk has no PSE (Penyelenggara Sistem Elektronik) registration of its own: it is covered inside the registration of
each product that embeds it (Shyden's ruling on shyden-labs/shydesk#79, 2026-11-10). Permenkominfo 5/2020 Art. 3(4)
asks each registration for the system's URL (c), its domain names and/or server IP addresses (d), the personal data it
processes (g), and where that data is processed and stored (h). Adding ShyDesk to a product that is already registered
is a change that must be reported (Art. 5), and untrue information is sanctioned (Art. 7(1)(c)).

Every line below was read from the code or the deployed configuration on 2026-11-22 (develop a5e324e), at the file
named beside it (first written 2026-11-10; brought up to date by shyden-labs/shydesk#258). Re-read them before each
submission: a change to any of those files can make this page untrue. `tests/unit/pse-registration-doc.test.ts`
fails if the logs or the live address here disagree with `wrangler.jsonc`.

## Addresses customers' browsers and mail reach (Art. 3(4)(c), (d))

| Environment | Address                                    | What reaches it                                                                                    | Source                                                    |
| ----------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Live        | `https://shydesk.dpdns.org`                | The support form each product embeds (`/embed.js`), uploads, the customer's private ticket link, the appeal page, and the product API | `wrangler.jsonc:14` (custom domain), `:10` (`workers_dev: false`); `docs/embedding.md:24` |
| Non-Prod    | `https://shydesk.shydesk-non-prod.workers.dev` | The same, for testing only; not used by customers                                                  | `wrangler.jsonc:34` (`workers_dev: true`), `:36` (no routes) |
| Both        | `challenges.cloudflare.com`                | The anti-spam check (Cloudflare Turnstile) the form runs before sending                            | `src/turnstile.ts:17`                                     |
| Both        | The product's sender address, via the SMTP host on port 587 | The no-reply notice email to the customer                                          | `src/mail/notify.ts:68`, `src/mail/socket.ts:93`          |

ShyDesk has no fixed server IP address: it runs on Cloudflare Workers, which answer from Cloudflare's shared network
addresses.

## Personal data stored, and how long it is kept (Art. 3(4)(g))

| Data                                                                                                         | Where                                                                  | Kept                                                                                                                                           | Source                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Customer's email address, subject, category and the extra form fields the product asks for                   | D1 `tickets` (`customer_email`, `subject`, `category`, `fields_json`)  | Until the ticket has been closed for the product's `text_keep_days` (default 365), then deleted with the ticket                                | `migrations/0001_release_1.sql:39-53`, `:13`; `src/timers/retention.ts` (`deleteText`) |
| Message text from the customer and from staff                                                                 | D1 `messages.body`                                                     | As above                                                                                                                                       | `migrations/0001_release_1.sql:57-65`                                                |
| Photos and videos the customer attaches (videos up to 30 s), with their type, size and length                | R2 bucket `shydesk-attachments`; D1 `attachments`                      | Files: until the ticket has been closed for the product's `attachments_keep_days` (default 30). Their rows: with the ticket's text             | `wrangler.jsonc:17`, `migrations/0001_release_1.sql:68-82`, `:12`; `src/desk/overdue.ts:27-33` |
| The address each notice email went to, when it was sent, and any bounce reported for it                      | D1 `notices` (`to_address`, `sent_at`, `bounced_at`, `bounce_status`, `bounce_reason`) | With the ticket's text                                                                                                                         | `migrations/0006_notices.sql:6-14`; `src/timers/retention.ts:70`                     |
| Customer's IP address and email address in the spam limits                                                   | D1 `counters` (keys `contact:ip:`, `contact:email:`, `upload-ip:`, `reply:ip:`, `appeal:ip:`) | Deleted once their one-hour window has passed: no row outlives its last use by more than one window                                             | `src/limits.ts:4-15`; `src/customer/appeal.ts:67`                                    |
| Request logs: each request's method and URL (ticket and product ids), its headers with `Authorization` masked (so ticket tokens are not kept), the visitor's IP address and user agent, and Cloudflare's location and network fields (country, region, city, postcode, latitude and longitude, ASN and its organisation, TLS details); ShyDesk's own error lines, where a mail failure can name the recipient's address | Cloudflare Workers Logs, live and Non-Prod | Kept by Cloudflare 3 days on Workers Free, 7 days on Workers Paid (Cloudflare's Workers Logs docs, read 2026-11-18). ShyDesk is built for Workers Free (`docs/superpowers/specs/2026-11-03-shydesk-v1-design.md:44`); the live account's plan has not been read from its billing page            | `wrangler.jsonc:12`; measured from a Non-Prod log event, 2026-11-18 (shyden-labs/shydesk#218, `docs/superpowers/specs/2026-11-03-shydesk-v1-design.md:105`) |
| Reports a product sends: the reporter's and the reported person's ids in that product, the reported item, the reason and its context | D1 `reports`; the ticket it opens                                      | Reason, context and reporter id: blanked with the ticket's text. The reported person's id and the item: kept on the bare ticket record (Shyden's ruling 2026-11-17, shyden-labs/shydesk#191) | `migrations/0004_release_2.sql:11-19`; `src/timers/retention.ts:71`                  |
| Punishments and appeals: the punished person's id in the product, what was applied and by which staff member, the appeal and its decision | D1 `punishments`, `appeals`                                            | No automatic deletion: kept as the record behind each ban                                                                                      | `migrations/0004_release_2.sql:23-48`                                                |
| Legal holds, their history and reports to the authorities: the staff member, notes, dates and the authority's reference | D1 `legal_holds`, `legal_hold_events`, `authority_reports`             | No automatic deletion. While a hold is active, nothing it covers is deleted; it may be lifted 365 days after a report to the authorities, or 90 days after each preservation request | `migrations/0004_release_2.sql:51-83`; `src/holds/rules.ts:18-20`; `src/timers/retention.ts:4-9` |
| Customer's IP address sent to Cloudflare Turnstile for the anti-spam check                                    | Not stored by ShyDesk                                                  | Sent once per check                                                                                                                            | `src/turnstile.ts:30`                                                                |
| Staff email addresses, their role, the products they answer for, and which tickets they have read            | D1 `staff`, `staff_products`, `reads`; `messages.staff_email`          | While the person is staff; read marks and staff message rows go with the ticket's text                                                         | `migrations/0001_release_1.sql:27-37`, `:109-115`                                    |

Not stored: the customer's name (unless a product's extra fields ask for it), passwords (customers have none; staff
sign in through Cloudflare Access), and cookies or browser storage (`public/embed.js`, `embed-media.js` and
`embed-viewer.js` use none; Cloudflare Turnstile's own script is Cloudflare's).

When a closed ticket's text is deleted but a report, punishment, appeal, hold or authority report points at it, a bare
ticket record stays: its id, product, type, status and dates, with no email address, subject, fields or link
(`src/timers/retention.ts:41-82`).

## Where data is processed and stored (Art. 3(4)(h))

- **Cloudflare Workers** run ShyDesk's code, on Cloudflare's global network (`wrangler.jsonc:8`).
- **Cloudflare D1** database `shydesk` holds the ticket text and the tables above (`wrangler.jsonc:26`, `:37`).
- **Cloudflare R2** bucket `shydesk-attachments` holds the photos and videos (`wrangler.jsonc:28`, `:38`).
- **Cloudflare Durable Objects** (`TicketTimer`) hold only each ticket's timer dates, no personal data
  (`wrangler.jsonc:29`, `:39`).
- **Cloudflare Turnstile** checks each form submission (`src/turnstile.ts`).
- **Sparked Host's mail server** sends the no-reply notice, over SMTP on port 587 with STARTTLS (`src/mail/socket.ts:6`,
  `:22`). The notice holds only the product's name and the private ticket link, never message text
  (`src/mail/notify.ts:8`, `:100`). Sparked Host passes outgoing mail through its filter, **MailBaby**, which so sees
  each recipient's address; where MailBaby processes it has not been measured.
- **Cloudflare Workers Logs** keep the request logs in the table above (`wrangler.jsonc:12`).
- **Cloudflare Access** signs staff in (`src/auth/access.ts:39-46`).

Read 2026-11-11 (shyden-labs/shydesk#109):

- The live D1 database `shydesk` and R2 bucket `shydesk-attachments` are in Cloudflare's **Asia-Pacific (APAC)**
  region, with no jurisdiction set (Cloudflare dashboard, ShyDesk account: D1 Settings "Region: Asia Pacific",
  "Jurisdiction: None"; R2 Settings "Location: Asia-Pacific (APAC)"). Cloudflare does not name the country within
  APAC.
- Sparked Host's mail server `web-par-01.sparkedhost.us` (45.43.163.116) is in **Paris, France** (`dig`, and
  ipinfo.io's location for that address).

## Ready to paste (English)

> Customer support for this product is handled by ShyDesk, Shyden Labs' help desk, which runs on Cloudflare Workers at
> https://shydesk.dpdns.org (no fixed server IP address; served from Cloudflare's network). Through its support form,
> ShyDesk processes the customer's email address, the request's subject, category and the fields the form asks for,
> message text, and any photos or videos the customer attaches. The customer's IP address is used for anti-spam checks
> (Cloudflare Turnstile) and rate limits, which delete it within about an hour. Cloudflare Workers Logs record each
> request, including the IP address, browser user agent and approximate location, and keep them for 3 days (7 if the account moves to Workers Paid). Staff
> email addresses are processed for staff sign-in (Cloudflare Access). Ticket text is stored in a Cloudflare D1
> database and attachments in Cloudflare R2 storage, both in Cloudflare's Asia-Pacific region; ticket text is deleted
> 365 days and attachments 30 days after the request is closed, unless the product sets other periods or a legal hold
> applies. Notice emails, which carry only a private link, are sent through Sparked Host's mail server in France and
> its outgoing filter, MailBaby.

The periods in that paragraph are ShyDesk's defaults: use the product's own `text_keep_days` and
`attachments_keep_days` from ShyDesk's admin settings when they differ.
