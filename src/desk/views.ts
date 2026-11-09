import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Canned } from '../products.ts';
import { PAGE_SIZE, fillCanned, type DeskAttachment, type DeskMessage, type DeskTicket } from './queries.ts';

/**
 * The staff desk's pages (shyden-labs/shydesk#24). Server-rendered HTML: every
 * value goes through `html`, which escapes it, so nothing a customer types can
 * run as markup. public/desk.js adds the unread badge and the canned-reply fill.
 */

type Page = HtmlEscapedString | Promise<HtmlEscapedString>;

const STATUS_NAMES: Record<string, string> = { open: 'Open', waiting: 'Waiting on customer', closed: 'Closed' };
const MAIL_LINES: Record<string, string> = {
  sent: 'Reply saved. The customer has been emailed.',
  failed: 'Reply saved, but the email could not be sent. The customer will see it on their private link.',
  'share-used-up': "Reply saved, but this product's monthly email share is used up. The customer will see it on their private link.",
  'no-link': 'Reply saved, but this ticket has no private link on record, so no email went.',
};

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const layout = (title: string, body: Page): Page =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · ShyDesk</title>
        <style>
          body {
            font:
              16px/1.5 system-ui,
              sans-serif;
            max-width: 60rem;
            margin: 0 auto;
            padding: 1rem;
          }
          nav a {
            margin-right: 0.75rem;
          }
          a[aria-current='page'] {
            font-weight: 700;
          }
          table {
            width: 100%;
            border-collapse: collapse;
          }
          th,
          td {
            text-align: left;
            padding: 0.5rem;
            border-bottom: 1px solid #ccc;
          }
          .table {
            overflow-x: auto;
          }
          .badge {
            font-weight: 700;
          }
          label {
            display: block;
            margin: 0.5rem 0;
          }
          textarea {
            width: 100%;
            min-height: 10rem;
            font: inherit;
            box-sizing: border-box;
          }
          select,
          button {
            font: inherit;
            padding: 0.5rem;
            min-height: 44px;
          }
          article {
            border-top: 1px solid #ccc;
            padding: 0.5rem 0;
          }
          .body {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
          }
          [role='status'] {
            font-weight: 600;
          }
        </style>
        <script type="module" src="/desk.js"></script>
      </head>
      <body>
        <p><a href="/desk">Tickets</a> <span class="badge" role="status" aria-label="Unread tickets" data-unread></span></p>
        ${body}
      </body>
    </html>`;

export interface ListData {
  products: { id: string; name: string }[];
  selected: string | undefined;
  showAll: boolean;
  status: string | undefined;
  typeId: string | undefined;
  types: { id: string; name: string }[];
  tickets: DeskTicket[];
  cursor: number;
  productNames: Map<string, string>;
}

const listLink = (d: ListData, changes: { product?: string | undefined; cursor?: number }): string => {
  const product = 'product' in changes ? changes.product : d.selected;
  const query = new URLSearchParams();
  if (product !== undefined) query.set('product', product);
  if (d.status !== undefined) query.set('status', d.status);
  if (d.typeId !== undefined) query.set('type', d.typeId);
  if (changes.cursor !== undefined) query.set('cursor', String(changes.cursor));
  const text = query.toString();
  return text === '' ? '/desk' : `/desk?${text}`;
};

export const listPage = (d: ListData): Page =>
  layout(
    'Tickets',
    html`<h1>Tickets</h1>
      <nav aria-label="Products">
        ${d.showAll ? html`<a href="${listLink(d, { product: undefined })}" aria-current="${d.selected === undefined ? 'page' : 'false'}">All products</a>` : ''}
        ${d.products.map(
          (p) => html`<a href="${listLink(d, { product: p.id })}" aria-current="${d.selected === p.id ? 'page' : 'false'}">${p.name}</a>`,
        )}
      </nav>
      <form method="get" action="/desk">
        ${d.selected === undefined ? '' : html`<input type="hidden" name="product" value="${d.selected}" />`}
        <label
          >Status
          <select name="status">
            <option value="">Any</option>
            ${Object.entries(STATUS_NAMES).map(
              ([value, name]) => html`<option value="${value}" ${d.status === value ? 'selected' : ''}>${name}</option>`,
            )}
          </select>
        </label>
        <label
          >Type
          <select name="type">
            <option value="">Any</option>
            ${d.types.map((t) => html`<option value="${t.id}" ${d.typeId === t.id ? 'selected' : ''}>${t.name}</option>`)}
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>
      ${
        d.tickets.length === 0
          ? html`<p>No tickets here.</p>`
          : html`<div class="table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Subject</th>
                    <th scope="col">Product</th>
                    <th scope="col">Status</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.tickets.map(
                    (t) =>
                      html`<tr>
                        <td><a href="/desk/tickets/${t.id}">${t.subject}</a></td>
                        <td>${d.productNames.get(t.product_id) ?? t.product_id}</td>
                        <td>${STATUS_NAMES[t.status] ?? t.status}</td>
                        <td>${when(t.updated_at)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      ${d.tickets.length === PAGE_SIZE ? html`<p><a href="${listLink(d, { cursor: d.cursor + PAGE_SIZE })}">Next page</a></p>` : ''}`,
  );

const fieldsOf = (json: string): [string, string][] => Object.entries(JSON.parse(json) as Record<string, string>);

/** A length in ms as m:ss. */
const minutes = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * A removed attachment's line, or a stored one's preview, which opens the
 * read-only viewer (shyden-labs/shydesk#25; public/desk.js). `number` is its
 * place among the ticket's stored files, so each control has its own name.
 */
const attachmentLine = (a: DeskAttachment, number: number): Page => {
  if (a.state === 'deleted') return html`<li>Attachment removed</li>`;
  const kind = a.mime.startsWith('video/') ? 'Video' : 'Photo';
  const length = a.duration_ms === null ? '' : `, ${minutes(a.duration_ms)}`;
  return html`<li>
    <button type="button" data-view data-id="${a.id}" data-mime="${a.mime}" aria-label="Open ${kind.toLowerCase()} ${String(number)}">
      <img src="/desk/files/${a.id}/thumb" alt="${kind} ${String(number)} preview" width="160" />
    </button>
    ${kind} ${String(number)}${length}, ${String(Math.ceil(a.bytes / 1000))} KB
  </li>`;
};

/** The ticket's stored files in the order the page shows them, so each is numbered by its place. */
const shownOrder = (messages: DeskMessage[], attachments: DeskAttachment[]): DeskAttachment[] =>
  messages.flatMap((m) => attachments.filter((a) => a.message_id === m.id && a.state !== 'deleted'));

export interface TicketData {
  ticket: DeskTicket;
  messages: DeskMessage[];
  attachments: DeskAttachment[];
  canned: Canned[];
  mail: string | undefined;
  error: string | undefined;
}

export const ticketPage = (d: TicketData): Page => {
  const line = d.error === 'empty' ? 'Enter a reply.' : d.mail === undefined ? undefined : MAIL_LINES[d.mail];
  const values = { customer_email: d.ticket.customer_email, ticket_subject: d.ticket.subject };
  const order = shownOrder(d.messages, d.attachments);
  return layout(
    d.ticket.subject,
    html`<h1>${d.ticket.subject}</h1>
      ${line === undefined ? '' : html`<p role="status" aria-label="Reply status">${line}</p>`}
      <p>${STATUS_NAMES[d.ticket.status] ?? d.ticket.status} · ${d.ticket.customer_email} · ${d.ticket.category}</p>
      <dl>
        ${fieldsOf(d.ticket.fields_json).map(
          ([name, value]) =>
            html`<dt>${name}</dt>
              <dd>${value}</dd>`,
        )}
      </dl>
      <section role="log" aria-label="Conversation">
        ${d.messages.map(
          (m) =>
            html`<article>
              <strong>${m.author === 'staff' ? (m.staff_email ?? 'Staff') : 'Customer'}</strong> · ${when(m.created_at)}
              <p class="body">${m.body}</p>
              <ul>
                ${d.attachments.filter((a) => a.message_id === m.id).map((a) => attachmentLine(a, order.indexOf(a) + 1))}
              </ul>
            </article>`,
        )}
      </section>
      <form method="post" action="/desk/tickets/${d.ticket.id}/reply">
        ${
          d.canned.length === 0
            ? ''
            : html`<p>
                Canned replies:
                ${d.canned.map((c) => html`<button type="button" data-canned data-body="${fillCanned(c.body, values)}">${c.name}</button> `)}
              </p>`
        }
        <label>Your reply <textarea name="body" data-reply maxlength="10000" required aria-label="Your reply"></textarea></label>
        <button type="submit">Send reply</button>
      </form>
      ${
        d.ticket.status === 'closed'
          ? ''
          : html`<form method="post" action="/desk/tickets/${d.ticket.id}/close"><button type="submit">Close ticket</button></form>`
      }`,
  );
};
