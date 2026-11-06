import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { overdueLine, type Overdue } from '../desk/overdue.ts';
import type { ApiKeySummary, Canned, Product, StaffInput, SupportField, TicketType } from '../products.ts';

/**
 * The admin settings pages (shyden-labs/shydesk#17). Plain server-rendered
 * HTML forms: every value goes through `html`, which escapes it, so nothing an
 * admin types can run as markup.
 */

type Page = HtmlEscapedString | Promise<HtmlEscapedString>;

/** What a product form shows: a stored product, or what was typed when it was refused. */
export interface ProductForm {
  id: string;
  name: string;
  senderAddress: string;
  ticketPageUrl: string;
  allowedOrigins: string;
  monthlyEmailShare: string;
  attachmentsKeepDays: string;
  textKeepDays: string;
}

export const toForm = (p: Product): ProductForm => ({
  id: p.id,
  name: p.name,
  senderAddress: p.senderAddress,
  ticketPageUrl: p.ticketPageUrl,
  allowedOrigins: p.allowedOrigins.join('\n'),
  monthlyEmailShare: String(p.monthlyEmailShare),
  attachmentsKeepDays: String(p.attachmentsKeepDays),
  textKeepDays: String(p.textKeepDays),
});

const EMPTY_FORM: ProductForm = {
  id: '',
  name: '',
  senderAddress: '',
  ticketPageUrl: '',
  allowedOrigins: '',
  monthlyEmailShare: '0',
  attachmentsKeepDays: '30',
  textKeepDays: '365',
};

const layout = (title: string, body: Page): Page =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · ShyDesk admin</title>
        <style>
          body {
            font:
              16px/1.5 system-ui,
              sans-serif;
            max-width: 48rem;
            margin: 0 auto;
            padding: 1rem;
          }
          label {
            display: block;
            margin-top: 0.75rem;
            font-weight: 600;
          }
          input,
          textarea,
          select {
            width: 100%;
            box-sizing: border-box;
            font: inherit;
            padding: 0.4rem;
          }
          input[type='checkbox'] {
            width: auto;
          }
          button {
            margin-top: 0.75rem;
            font: inherit;
            padding: 0.4rem 1rem;
          }
          [role='alert'] {
            border: 2px solid #b00020;
            padding: 0.5rem 1rem;
          }
          output {
            font-family: monospace;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <nav aria-label="Admin"><a href="/admin">Products</a> · <a href="/admin/staff">Staff</a></nav>
        <main>
          <h1>${title}</h1>
          ${body}
        </main>
      </body>
    </html>`;

const errorList = (errors: string[]): Page | '' =>
  errors.length === 0
    ? ''
    : html`<div role="alert">
        <p>Not saved:</p>
        <ul>
          ${errors.map((e) => html`<li>${e}</li>`)}
        </ul>
      </div>`;

const productFields = (f: ProductForm, idLocked: boolean): Page => html`
  <label for="id">Product id</label>
  <input id="id" name="id" value="${f.id}" ${idLocked ? 'readonly' : ''} required />
  <label for="name">Name</label>
  <input id="name" name="name" value="${f.name}" required />
  <label for="senderAddress">Sender address</label>
  <input id="senderAddress" name="senderAddress" type="email" value="${f.senderAddress}" required />
  <label for="ticketPageUrl">Ticket page URL</label>
  <input id="ticketPageUrl" name="ticketPageUrl" type="url" value="${f.ticketPageUrl}" required />
  <label for="allowedOrigins">Allowed origins, one per line</label>
  <textarea id="allowedOrigins" name="allowedOrigins" rows="3" required>${f.allowedOrigins}</textarea>
  <label for="monthlyEmailShare">Monthly email share</label>
  <input id="monthlyEmailShare" name="monthlyEmailShare" type="number" min="0" step="1" value="${f.monthlyEmailShare}" required />
  <label for="attachmentsKeepDays">Keep attachments for (days)</label>
  <input id="attachmentsKeepDays" name="attachmentsKeepDays" type="number" min="1" step="1" value="${f.attachmentsKeepDays}" required />
  <label for="textKeepDays">Keep ticket text for (days)</label>
  <input id="textKeepDays" name="textKeepDays" type="number" min="1" step="1" value="${f.textKeepDays}" required />
`;

/** What the admin desk shows about storage and timers (shyden-labs/shydesk#22 AC3), worked out when the page loads. */
export interface Health {
  /** The storage warning from 80 % of the free tier, or null. */
  warning: string | null;
  overdue: Overdue[];
}

const healthPanel = (h: Health) =>
  html`<h2>Storage and timers</h2>
    ${h.warning === null ? '' : html`<p role="alert">${h.warning}</p>`}
    ${
      h.overdue.length === 0
        ? html`<p>Nothing is past its due date.</p>`
        : html`<ul>
            ${h.overdue.map((o) => html`<li>${overdueLine(o)}</li>`)}
          </ul>`
    }`;

/** The products list with the add-a-product form, under the storage and timers panel. */
export const productsPage = (products: Product[], health: Health, form: ProductForm = EMPTY_FORM, errors: string[] = []): Page =>
  layout(
    'Products',
    html`${healthPanel(health)}
      <h2>Products</h2>
      <ul>
        ${products.map((p) => html`<li><a href="/admin/products/${p.id}">${p.name}</a> (${p.id})</li>`)}
      </ul>
      <h2>Add a product</h2>
      ${errorList(errors)}
      <form method="post" action="/admin/products">${productFields(form, false)}<button type="submit">Add product</button></form>`,
  );

/** One support field per line, as the support form's textarea shows it. */
export const fieldsToText = (fields: SupportField[]): string =>
  fields
    .map((f) => [f.label, f.kind, f.required ? 'required' : 'optional', ...(f.options?.length ? [f.options.join(', ')] : [])].join('; '))
    .join('\n');

export interface ProductPageData {
  product: Product;
  form?: ProductForm;
  type: TicketType | null;
  /** What was typed in the support form when it was refused. */
  supportForm?: { name: string; fields: string };
  canned: Canned[];
  keys: ApiKeySummary[];
  /** Errors, by the form they belong to. */
  errors?: { product?: string[]; support?: string[]; canned?: string[]; keys?: string[] };
  /** A key just made: shown on this one page and never again. */
  newKey?: string;
}

/** A product's settings: the product, its support fields, canned replies and API keys. */
export const productPage = (d: ProductPageData): Page => {
  const id = d.product.id;
  const support = d.supportForm ?? { name: d.type?.name ?? 'Support', fields: fieldsToText(d.type?.fields ?? []) };
  return layout(
    d.product.name,
    html`<h2>Settings</h2>
      ${errorList(d.errors?.product ?? [])}
      <form method="post" action="/admin/products/${id}">
        ${productFields(d.form ?? toForm(d.product), true)}<button type="submit">Save settings</button>
      </form>

      <h2>Support form fields</h2>
      ${errorList(d.errors?.support ?? [])}
      <form method="post" action="/admin/products/${id}/support">
        <label for="supportName">Ticket type name</label>
        <input id="supportName" name="name" value="${support.name}" required />
        <label for="fields">Extra fields, one per line: label; text or select; required or optional; options for a choice list</label>
        <textarea id="fields" name="fields" rows="4">${support.fields}</textarea>
        <button type="submit">Save support fields</button>
      </form>

      <h2>Canned replies</h2>
      <ul>
        ${d.canned.map((c) => html`<li><strong>${c.name}</strong>: ${c.body}</li>`)}
      </ul>
      ${errorList(d.errors?.canned ?? [])}
      <form method="post" action="/admin/products/${id}/canned">
        <label for="cannedName">Name</label>
        <input id="cannedName" name="name" required />
        <label for="cannedBody">Reply text</label>
        <textarea id="cannedBody" name="body" rows="3" required></textarea>
        <label for="cannedType">Offered on</label>
        <select id="cannedType" name="typeId">
          <option value="">Every ticket type</option>
          ${d.type ? html`<option value="${d.type.id}">${d.type.name}</option>` : ''}
        </select>
        <button type="submit">Add canned reply</button>
      </form>

      <h2>API keys</h2>
      ${
        d.newKey
          ? html`<div role="status">
              <p>New key, shown once. Copy it now; only its hash is kept.</p>
              <output id="newKey">${d.newKey}</output>
            </div>`
          : ''
      }
      <ul>
        ${d.keys.map(
          (k) =>
            html`<li>
              ${k.label}
              (${k.hash.slice(0, 12)}…)${
                k.revokedAt === null
                  ? html` <form method="post" action="/admin/products/${id}/api-keys/${k.hash}/revoke" style="display:inline">
                      <button type="submit">Revoke ${k.label}</button>
                    </form>`
                  : ' revoked'
              }
            </li>`,
        )}
      </ul>
      ${errorList(d.errors?.keys ?? [])}
      <form method="post" action="/admin/products/${id}/api-keys">
        <label for="keyLabel">Label</label>
        <input id="keyLabel" name="label" required />
        <button type="submit">Create API key</button>
      </form>`,
  );
};

/** Staff and their product grants, with the add-or-change form. */
export const staffPage = (staff: StaffInput[], products: Product[], errors: string[] = []): Page =>
  layout(
    'Staff',
    html`<ul>
        ${staff.map((s) => html`<li>${s.email}: ${s.role}${s.role === 'rep' ? html`, ${s.products.join(', ') || 'no products'}` : ''}</li>`)}
      </ul>
      <h2>Add or change staff</h2>
      ${errorList(errors)}
      <form method="post" action="/admin/staff">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required />
        <label for="role">Role</label>
        <select id="role" name="role">
          <option value="rep">Rep</option>
          <option value="admin">Admin</option>
        </select>
        <fieldset>
          <legend>Products a rep may see</legend>
          ${products.map((p) => html`<label><input type="checkbox" name="products" value="${p.id}" /> ${p.name}</label>`)}
        </fieldset>
        <button type="submit">Save staff</button>
      </form>`,
  );
