import { html } from 'hono/html';
import type { LegalReview, TicketHold, TicketHolds } from '../holds/holds.ts';
import type { HoldReason } from '../holds/rules.ts';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { Canned } from '../products.ts';
import type { PunishmentRow } from '../db/types.ts';
import {
  PAGE_SIZE,
  fillCanned,
  type AppealPanel,
  type DeskAttachment,
  type DeskMessage,
  type DeskNotice,
  type DeskTicket,
  type ReportPanel,
} from './queries.ts';

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

/** What the page says after a punishment was sent, or why an action was refused (shyden-labs/shydesk#60). */
const PUNISHMENT_LINES: Record<string, string> = {
  applied: 'The product applied it.',
  failed: 'The punishment was recorded, but the product did not apply it.',
};
const PUNISHMENT_ERRORS: Record<string, string> = {
  unknown_punishment: "Pick one of the product's punishments.",
  no_token_key: 'Punishments cannot be sent: TICKET_TOKEN_KEY is not set on this ShyDesk.',
  nothing_to_send: 'There is nothing to send again.',
  already_lifted: 'That punishment is already lifted.',
};

/** What the page says after an appeal was decided, or why a decision was refused (shyden-labs/shydesk#61). */
const APPEAL_LINES: Record<string, string> = {
  applied: 'Appeal upheld: the product lifted the punishment.',
  failed: 'Appeal upheld and the punishment lifted here, but the product did not apply the lift. Send it again from the report.',
  upheld: 'Appeal upheld. The punishment was already lifted.',
  rejected: 'Appeal rejected. No further appeal is taken.',
};
const APPEAL_ERRORS: Record<string, string> = {
  already_decided: 'This appeal was already decided.',
  unknown_outcome: 'Choose to uphold or reject the appeal.',
};

/** Why a legal hold action, or closing, was refused (shyden-labs/shydesk#62). */
const HOLD_ERRORS: Record<string, string> = {
  not_yet: 'This hold cannot be lifted yet.',
  authority_report_owed: 'Record the report to the authorities before closing this ticket.',
  basis_required: 'Enter the report or request date.',
  basis_refused: 'A possible crime not yet reported takes no date.',
  note_required: 'Say why the evidence is held.',
  unknown_reason: 'Choose why the evidence is held.',
  reason_required: 'Fill in every field.',
  date_required: 'Enter the date of the report.',
  already_reported: 'A report to the authorities is already recorded for this ticket.',
};
/** What the page says after a hold action. */
const HOLD_LINES: Record<string, string> = {
  placed: 'Legal hold placed.',
  lifted: 'Legal hold lifted.',
  renewed: 'Legal hold renewed.',
  order: 'Production order mark saved.',
  no_report: 'Recorded that no report is needed.',
  reported: 'Report to the authorities recorded.',
};
const HOLD_REASONS: Record<HoldReason, string> = {
  crime_unreported: 'Possible crime, not yet reported',
  reported: 'Reported to the authorities',
  preservation: 'Preservation request',
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
  /** The admin's legal review (shyden-labs/shydesk#62); none for a rep. */
  legal?: LegalReview;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** A bare ticket row has no subject left (shyden-labs/shydesk#191). */
const subjectOf = (t: Pick<DeskTicket, 'subject' | 'text_deleted_at'>): string => (t.text_deleted_at === null ? t.subject : 'Text deleted');

/** The admin's legal duties first, then holds due for review; nothing when neither has any. */
const legalSections = (legal: LegalReview | undefined): Page | string => {
  if (legal === undefined) return '';
  return html`${
    legal.duties.length === 0
      ? ''
      : html`<section aria-labelledby="legal-duty">
          <h2 id="legal-duty">Legal duty outstanding</h2>
          <ul>
            ${legal.duties.map(
              (d) => html`<li><a href="/desk/tickets/${d.ticketId}">${d.subject}</a>: report to the authorities not yet recorded</li>`,
            )}
          </ul>
        </section>`
  }${
    legal.due.length === 0
      ? ''
      : html`<section aria-labelledby="holds-due">
          <h2 id="holds-due">Holds due for review</h2>
          <ul>
            ${legal.due.map((h) => html`<li><a href="/desk/tickets/${h.ticketId}">${h.subject}</a>: may be lifted since ${day(h.earliest)}</li>`)}
          </ul>
        </section>`
  }`;
};

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

const currentWhen = (current: boolean): string => (current ? 'page' : 'false');

/** A link to the next page when this one is full. */
const nextPageLink = (d: ListData): Page | '' => {
  if (d.tickets.length !== PAGE_SIZE) return '';
  const next = listLink(d, { cursor: d.cursor + PAGE_SIZE });
  return html`<p><a href="${next}">Next page</a></p>`;
};

/** The list's marker for a ticket whose latest notice bounced (shyden-labs/shydesk#232). */
const bouncedMark = (t: DeskTicket) => (t.last_notice_bounced === 1 ? html` · <strong>Email bounced</strong>` : '');

export const listPage = (d: ListData): Page =>
  layout(
    'Tickets',
    html`<h1>Tickets</h1>
      ${legalSections(d.legal)}
      <nav aria-label="Products">
        ${d.showAll ? html`<a href="${listLink(d, { product: undefined })}" aria-current="${currentWhen(d.selected === undefined)}">All products</a>` : ''}
        ${d.products.map(
          (p) => html`<a href="${listLink(d, { product: p.id })}" aria-current="${currentWhen(d.selected === p.id)}">${p.name}</a>`,
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
              <table aria-label="Ticket list">
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
                        <td><a href="/desk/tickets/${t.id}">${subjectOf(t)}</a></td>
                        <td>${d.productNames.get(t.product_id) ?? t.product_id}</td>
                        <td>${STATUS_NAMES[t.status] ?? t.status}${bouncedMark(t)}</td>
                        <td>${when(t.updated_at)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      ${nextPageLink(d)}`,
  );

const fieldsOf = (json: string): [string, string][] => Object.entries(JSON.parse(json) as Record<string, string>);

/** A length in ms as m:ss. */
const minutes = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * A removed or withheld attachment's line, or a stored one's preview, which opens the
 * read-only viewer (shyden-labs/shydesk#25; public/desk.js). `number` is its
 * place among the ticket's stored files, so each control has its own name.
 */
const attachmentLine = (a: DeskAttachment, number: number): Page => {
  if (a.state === 'deleted') return html`<li>Attachment removed</li>`;
  if (a.withheld === 1) return html`<li>Evidence withheld under legal hold</li>`;
  const kind = a.mime.startsWith('video/') ? 'Video' : 'Photo';
  const length = a.duration_ms === null ? '' : `, ${minutes(a.duration_ms)}`;
  return html`<li>
    <button type="button" data-view data-id="${a.id}" data-mime="${a.mime}" aria-label="Open ${kind.toLowerCase()} ${String(number)}">
      <img src="/desk/files/${a.id}/thumb" alt="${kind} ${String(number)} preview" width="160" />
    </button>
    ${kind} ${String(number)}${length}, ${String(Math.ceil(a.bytes / 1000))} KB
  </li>`;
};

/** The ticket's stored, viewable files in the order the page shows them, so each is numbered by its place. */
const shownOrder = (messages: DeskMessage[], attachments: DeskAttachment[]): DeskAttachment[] =>
  messages.flatMap((m) => attachments.filter((a) => a.message_id === m.id && a.state !== 'deleted' && a.withheld !== 1));

export interface TicketData {
  ticket: DeskTicket;
  messages: DeskMessage[];
  attachments: DeskAttachment[];
  /** Notices that bounced (shyden-labs/shydesk#232); none when absent. */
  notices?: DeskNotice[];
  canned: Canned[];
  mail: string | undefined;
  error: string | undefined;
  /** A report's details, history and punishments; absent on other tickets. */
  report?: ReportPanel | null;
  /** The outcome of the last punishment sent, from the redirect. */
  punishment?: string | undefined;
  /** An appeal's decision and the punishment it is about; only ever given to the admin. */
  appeal?: AppealPanel | null;
  /** The outcome of the last appeal decision, from the redirect. */
  appealOutcome?: string | undefined;
  isAdmin?: boolean;
  /** The ticket's live legal holds and recorded report (shyden-labs/shydesk#62). */
  holds?: TicketHolds;
  /** The last hold action done, from the redirect. */
  holdDone?: string | undefined;
}

/** ` (error)` after a state, or nothing when there is no error. */
const inBrackets = (error: string | null): string => (error === null ? '' : ' (' + error + ')');

const stateLine = (p: PunishmentRow): string => {
  const sent = `${p.label}: ${p.send_state}${inBrackets(p.send_error)}`;
  if (p.lifted_at === null) return sent;
  const lift = `lift ${p.lift_state ?? 'sending'}${inBrackets(p.lift_error)}`;
  return `${sent}, lifted by ${p.lifted_by ?? ''}, ${lift}`;
};

/** The report panel: what was reported, the subject's history here, and the punishments. */
const reportSection = (r: ReportPanel, ticketId: string, isAdmin: boolean): Page =>
  html`<section aria-label="Report">
    <h2>Report</h2>
    <p>Reported by ${r.reporter_id} · ${r.item_kind} ${r.item_id} · About ${r.subject_user_id} · ${r.reason}</p>
    <h3>Earlier in this product</h3>
    ${
      r.history.reports.length === 0 && r.history.punishments.length === 0
        ? html`<p>Nothing earlier.</p>`
        : html`<ul>
            ${r.history.reports.map((h) => html`<li>Report: ${h.reason} · ${h.status} · ${when(h.created_at)}</li>`)}
            ${r.history.punishments.map((h) => html`<li>Punishment: ${h.label} · ${h.send_state}${h.lifted_at === null ? '' : ' · lifted'}</li>`)}
          </ul>`
    }
    <h3>Punishments</h3>
    <ul>
      ${r.punishments.map(
        (p) =>
          html`<li>
            ${stateLine(p)}
            ${
              (p.send_state === 'failed' && p.lifted_at === null) || (isAdmin && p.lift_state === 'failed')
                ? html`<form method="post" action="/desk/punishments/${p.id}/resend" style="display:inline">
                    <button type="submit">Send again</button>
                  </form>`
                : ''
            }
            ${
              isAdmin && p.lifted_at === null
                ? html`<form method="post" action="/desk/punishments/${p.id}/lift" style="display:inline">
                    <button type="submit">Lift</button>
                  </form>`
                : ''
            }
          </li>`,
      )}
    </ul>
    ${
      r.choices.length === 0
        ? html`<p>This product has no punishments set.</p>`
        : html`<form method="post" action="/desk/tickets/${ticketId}/punish">
            <label for="punishmentKey">Punishment</label>
            <select id="punishmentKey" name="key">
              ${r.choices.map((p) => html`<option value="${p.key}">${p.label}</option>`)}
            </select>
            <button type="submit">Apply punishment</button>
          </form>`
    }
  </section>`;

const DECIDED: Record<string, string> = { upheld: 'Upheld', rejected: 'Rejected' };

/** The appeal panel: the punishment appealed, and the decision or the buttons to make it. */
const decidedLine = (a: AppealPanel): Page => {
  const at = a.decided_at === null ? '' : when(a.decided_at);
  return html`<p>${DECIDED[a.state] ?? a.state} by ${a.decided_by ?? ''}, ${at}.</p>`;
};

const appealSection = (a: AppealPanel, ticketId: string): Page =>
  html`<section aria-label="Appeal">
    <h2>Appeal of ${a.label}</h2>
    <p><a href="/desk/tickets/${a.report_ticket_id}">Open the report</a></p>
    ${
      a.state === 'open'
        ? html`<p>Waiting for a decision.</p>
            <form method="post" action="/desk/tickets/${ticketId}/appeal">
              <button type="submit" name="outcome" value="upheld">Uphold and lift</button>
              <button type="submit" name="outcome" value="rejected">Reject</button>
            </form>`
        : decidedLine(a)
    }
  </section>`;

const fileName = (a: DeskAttachment, order: DeskAttachment[]): string => {
  const number = order.indexOf(a) + 1;
  if (number === 0) return 'a withheld file';
  const kind = a.mime.startsWith('video/') ? 'Video' : 'Photo';
  return `${kind} ${String(number)}`;
};

const holdLine = (h: TicketHold, d: TicketData, order: DeskAttachment[]): string => {
  const file = d.attachments.find((a) => a.id === h.attachmentId);
  let covers = 'the whole ticket';
  if (h.attachmentId !== null) covers = file === undefined ? 'a file' : fileName(file, order);
  const release = h.earliest === null ? 'Cannot be lifted yet.' : `May be lifted from ${day(h.earliest)}.`;
  const csam = h.csam ? ', suspected child-abuse material,' : '';
  const pendingOrder = h.orderPending ? ' Production order pending.' : '';
  const noReport = h.noReportReason === null ? '' : ' No report needed: ' + h.noReportReason + '.';
  return `${HOLD_REASONS[h.reason]}${csam} on ${covers}: ${h.note}. Placed by ${h.placedBy}, ${when(h.placedAt)}. ${release}${pendingOrder}${noReport}`;
};

/** The admin's actions on one hold: lift, and those its reason allows. */
const holdActions = (h: TicketHold, ticketId: string): Page => {
  const to = (action: string) => `/desk/tickets/${ticketId}/holds/${h.id}/${action}`;
  const nextPending = h.orderPending ? '0' : '1';
  const orderButton = h.orderPending ? 'Mark the order answered' : 'Mark a production order pending';
  return html`<form method="post" action="${to('lift')}"><button type="submit">Lift</button></form>
    ${
      h.reason === 'preservation'
        ? html`<form method="post" action="${to('renew')}">
              <label>Renewal request <input name="note" required /></label><button type="submit">Renew</button>
            </form>
            <form method="post" action="${to('order')}">
              <input type="hidden" name="pending" value="${nextPending}" />
              <button type="submit">${orderButton}</button>
            </form>`
        : ''
    }
    ${
      h.reason === 'crime_unreported' && h.noReportReason === null
        ? html`<form method="post" action="${to('no-report')}">
            <label>Why no report is needed <input name="reason" required /></label><button type="submit">No report needed</button>
          </form>`
        : ''
    }`;
};

/** The report to the authorities once recorded; before that, the admin's form to record it. */
const authorityReport = (report: TicketHolds['report'], admin: boolean, ticketId: string): Page | string => {
  if (report !== null) {
    return html`<p>
      Reported to ${report.reportedTo} on ${day(report.reportedAt)}, reference ${report.reference}, recorded by ${report.recordedBy}.
    </p>`;
  }
  if (!admin) return '';
  return html`<form method="post" action="/desk/tickets/${ticketId}/authority-report">
    <label>Reported to <input name="reported_to" required /></label>
    <label>Date <input type="date" name="reported_at" required /></label>
    <label>Reference <input name="reference" required /></label>
    <button type="submit">Record report to the authorities</button>
  </form>`;
};

/** Live holds, the form to place one, and for the admin each hold's actions and the authority report. */
const holdsPanel = (d: TicketData, order: DeskAttachment[]): Page | string => {
  if (d.holds === undefined) return '';
  const { holds, report } = d.holds;
  const admin = d.isAdmin === true;
  return html`<section aria-labelledby="holds">
    <h2 id="holds">Legal holds</h2>
    ${
      holds.length === 0
        ? html`<p>No live holds.</p>`
        : html`<ul>
            ${holds.map(
              (h) =>
                html`<li>
                  <p>${holdLine(h, d, order)}</p>
                  ${admin ? holdActions(h, d.ticket.id) : ''}
                </li>`,
            )}
          </ul>`
    }
    <form method="post" action="/desk/tickets/${d.ticket.id}/holds">
      <label
        >Reason
        <select name="reason">
          ${Object.entries(HOLD_REASONS).map(([value, name]) => html`<option value="${value}">${name}</option>`)}
        </select>
      </label>
      <label
        >Covers
        <select name="attachment">
          <option value="">Whole ticket</option>
          ${order.map((a) => html`<option value="${a.id}">${fileName(a, order)}</option>`)}
        </select>
      </label>
      <label><input type="checkbox" name="csam" /> Suspected child-abuse material</label>
      <label>Report or request date <input type="date" name="basis" /></label>
      <label>Why <input name="note" required /></label>
      <button type="submit">Place hold</button>
    </form>
    ${authorityReport(report, admin, d.ticket.id)}
  </section>`;
};

/** The reply box, with the product's canned replies filled for this ticket. */
const replyForm = (d: TicketData, values: Parameters<typeof fillCanned>[1]) =>
  html`<form method="post" action="/desk/tickets/${d.ticket.id}/reply">
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
  </form>`;

/** The first notice that applies: an empty reply, a refused action, an action done, a reply's email. */
const noticeLine = (d: TicketData): string | undefined => {
  if (d.error === 'empty') return 'Enter a reply.';
  if (d.error === 'text-deleted') return 'This ticket’s text has been deleted, so it cannot be replied to.';
  return (
    PUNISHMENT_ERRORS[d.error ?? ''] ??
    APPEAL_ERRORS[d.error ?? ''] ??
    HOLD_ERRORS[d.error ?? ''] ??
    HOLD_LINES[d.holdDone ?? ''] ??
    PUNISHMENT_LINES[d.punishment ?? ''] ??
    APPEAL_LINES[d.appealOutcome ?? ''] ??
    MAIL_LINES[d.mail ?? '']
  );
};

/** A notice that bounced, under the message it announced (shyden-labs/shydesk#232). */
const bounceLine = (n: DeskNotice) => {
  const reason = n.bounce_reason === '' ? n.bounce_status : n.bounce_reason;
  return html`<p role="alert">Email to ${n.to_address} bounced at ${when(n.bounced_at)}: ${reason}</p>`;
};

export const ticketPage = (d: TicketData): Page => {
  const line = noticeLine(d);
  const values = { customer_email: d.ticket.customer_email, ticket_subject: d.ticket.subject };
  const order = shownOrder(d.messages, d.attachments);
  return layout(
    subjectOf(d.ticket),
    html`<h1>${subjectOf(d.ticket)}</h1>
      ${line === undefined ? '' : html`<p role="status" aria-label="Reply status">${line}</p>`}
      <p>${STATUS_NAMES[d.ticket.status] ?? d.ticket.status} · ${d.ticket.customer_email} · ${d.ticket.category}</p>
      <dl>
        ${fieldsOf(d.ticket.fields_json).map(
          ([name, value]) =>
            html`<dt>${name}</dt>
              <dd>${value}</dd>`,
        )}
      </dl>
      ${d.report ? reportSection(d.report, d.ticket.id, d.isAdmin === true) : ''}
      ${d.appeal && d.isAdmin === true ? appealSection(d.appeal, d.ticket.id) : ''} ${holdsPanel(d, order)}
      <section role="log" aria-label="Conversation">
        ${d.messages.map(
          (m, index) =>
            html`<article>
              <strong>${m.author === 'staff' ? (m.staff_email ?? 'Staff') : 'Customer'}</strong> · ${when(m.created_at)}
              <p class="body">${m.body}</p>
              ${(d.notices ?? []).filter((n) => n.message_id === m.id || (n.message_id === null && index === 0)).map(bounceLine)}
              <ul>
                ${d.attachments.filter((a) => a.message_id === m.id).map((a) => attachmentLine(a, order.indexOf(a) + 1))}
              </ul>
            </article>`,
        )}
      </section>
      ${
        d.ticket.text_deleted_at === null
          ? replyForm(d, values)
          : html`<p>
              This ticket’s text was deleted on ${day(d.ticket.text_deleted_at)} under its retention period; its records are kept.
            </p>`
      }
      ${
        d.ticket.status === 'closed'
          ? ''
          : html`<form method="post" action="/desk/tickets/${d.ticket.id}/close"><button type="submit">Close ticket</button></form>`
      }`,
  );
};
