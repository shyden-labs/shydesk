# ShyDesk's part of each product's PSE registration

ShyDesk has no PSE (Penyelenggara Sistem Elektronik) registration of its own: it is covered inside the registration of
each product that embeds it (Shyden's ruling on shyden-labs/shydesk#79, 2026-11-10). Permenkominfo 5/2020 Art. 3(4)
asks each registration for the system's URL (c), its domain names and/or server IP addresses (d), the personal data it
processes (g), and where that data is processed and stored (h). Adding ShyDesk to a product that is already registered
is a change that must be reported (Art. 5), and untrue information is sanctioned (Art. 7(1)(c)).

Every line below was read from the code or the deployed configuration on 2026-11-10, at the file named beside it.
Re-read them before each submission: a change to any of those files can make this page untrue.

## Addresses customers' browsers and mail reach (Art. 3(4)(c), (d))

| Environment | Address                                    | What reaches it                                                                                    | Source                                                    |
| ----------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Live        | `https://shydesk.dpdns.org` (planned)      | The support form each product embeds (`/embed.js`), uploads, and the customer's private ticket link | `docs/embedding.md:24`                                    |
| Live        | none served yet                            | The live Worker has no address until the domain is set up (shyden-labs/shydesk#13)                 | `wrangler.jsonc:10` (`workers_dev: false`, no `routes`)   |
| Non-Prod    | `https://shydesk.shydesk-non-prod.workers.dev` | The same, for testing only; not used by customers                                                  | `wrangler.jsonc:23` (`workers_dev: true`)                 |
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
| Customer's IP address and email address in the spam limits                                                   | D1 `counters` (keys `contact:ip:`, `contact:email:`, `upload-ip:`, `reply:ip:`) | Deleted once their one-hour window has passed: no row outlives its last use by more than one window                                             | `src/limits.ts:4-15`                                                                 |
| Customer's IP address sent to Cloudflare Turnstile for the anti-spam check                                    | Not stored by ShyDesk                                                  | Sent once per check                                                                                                                            | `src/turnstile.ts:30`                                                                |
| Staff email addresses, their role, the products they answer for, and which tickets they have read            | D1 `staff`, `staff_products`, `reads`; `messages.staff_email`          | While the person is staff; read marks and staff message rows go with the ticket's text                                                         | `migrations/0001_release_1.sql:27-37`, `:109-115`                                    |

Not stored: the customer's name (unless a product's extra fields ask for it), passwords (customers have none; staff
sign in through Cloudflare Access), and request logs (`wrangler.jsonc` sets no `observability`, so Workers Logs are
off).

## Where data is processed and stored (Art. 3(4)(h))

- **Cloudflare Workers** run ShyDesk's code, on Cloudflare's global network (`wrangler.jsonc:7`).
- **Cloudflare D1** database `shydesk` holds the ticket text and the tables above (`wrangler.jsonc:15`, `:24`).
- **Cloudflare R2** bucket `shydesk-attachments` holds the photos and videos (`wrangler.jsonc:17`, `:25`).
- **Cloudflare Durable Objects** (`TicketTimer`) hold only each ticket's timer dates, no personal data
  (`wrangler.jsonc:18`).
- **Cloudflare Turnstile** checks each form submission (`src/turnstile.ts`).
- **Sparked Host's mail server** sends the no-reply notice, over SMTP on port 587 with STARTTLS (`src/mail/socket.ts`).
- **Cloudflare Access** signs staff in (`src/auth/access.ts:39-46`).

Still to read before submitting (Shyden, in the dashboards): the region Cloudflare placed the live D1 database and R2
bucket in (Cloudflare's dashboard, the ShyDesk account), and the country of the Sparked Host mail server.

## Ready to paste (English)

> Customer support for this product is handled by ShyDesk, Shyden Labs' help desk, which runs on Cloudflare Workers at
> https://shydesk.dpdns.org (no fixed server IP address; served from Cloudflare's network). Through its support form,
> ShyDesk processes the customer's email address, the request's subject, category and the fields the form asks for,
> message text, and any photos or videos the customer attaches; the customer's IP address is used for anti-spam checks
> (Cloudflare Turnstile) and rate limits, and deleted within about an hour. Staff email addresses are processed for
> staff sign-in (Cloudflare Access). Ticket text is stored in a Cloudflare D1 database and attachments in Cloudflare R2
> storage; ticket text is deleted 365 days and attachments 30 days after the request is closed, unless the product sets
> other periods. Notice emails are sent through Sparked Host's mail server. No request logs are kept.

The periods in that paragraph are ShyDesk's defaults: use the product's own `text_keep_days` and
`attachments_keep_days` from ShyDesk's admin settings when they differ.
