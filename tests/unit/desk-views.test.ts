import { describe, expect, it } from 'vitest';
import { getFile, getTicket, listTickets, markRead, unreadCount, type DeskNotice, type DeskTicket } from '../../src/desk/queries.ts';
import { listPage, ticketPage, type ListData, type TicketData } from '../../src/desk/views.ts';
import { standInDb } from './d1-stand-in.ts';

// The desk's pages and the corners of its queries that the routes do not reach
// (shyden-labs/shydesk#24). The SQL itself is proven in tests/integration/desk.test.ts.
const ticket: DeskTicket = {
  id: 't1',
  product_id: 'shytalk',
  type_id: 'shytalk:support',
  status: 'open',
  customer_email: 'ana@example.com',
  subject: 'Sign in',
  category: 'bug',
  fields_json: '{}',
  created_at: 5,
  updated_at: 6,
  seq: 1,
  token_sealed: null,
  text_deleted_at: null,
  test_origin: null,
  last_notice_bounced: 0,
};

const list = (over: Partial<ListData> = {}): ListData => ({
  products: [{ id: 'shytalk', name: 'ShyTalk' }],
  selected: undefined,
  showAll: true,
  status: undefined,
  typeId: undefined,
  types: [{ id: 'shytalk:support', name: 'Support' }],
  tickets: [ticket],
  cursor: 0,
  productNames: new Map([['shytalk', 'ShyTalk']]),
  ...over,
});

const view = (over: Partial<TicketData> = {}): TicketData => ({
  ticket,
  messages: [],
  attachments: [],
  canned: [],
  mail: undefined,
  error: undefined,
  ...over,
});

const render = async (page: ReturnType<typeof listPage>): Promise<string> => String(await page);

describe('listPage', () => {
  it('names the ticket table, so assistive technology and the journeys find it', async () => {
    expect(await render(listPage(list()))).toContain('<table aria-label="Ticket list">');
  });

  it('marks "All products" current when no product is chosen', async () => {
    const page = await render(listPage(list()));
    expect(page).toContain('<a href="/desk" aria-current="page">All products</a>');
    expect(page).toContain('<a href="/desk?product=shytalk" aria-current="false">ShyTalk</a>');
  });

  it('marks the chosen product current, keeps it in the filter form, and keeps the filters on its links', async () => {
    const page = await render(listPage(list({ selected: 'shytalk', status: 'open', typeId: 'shytalk:support' })));
    expect(page).toContain('href="/desk?product=shytalk&amp;status=open&amp;type=shytalk%3Asupport" aria-current="page"');
    expect(page).toContain('<input type="hidden" name="product" value="shytalk" />');
    expect(page).toContain('<option value="open" selected>Open</option>');
    expect(page).toContain('<option value="shytalk:support" selected>Support</option>');
  });

  it('says so when no ticket matches', async () => {
    expect(await render(listPage(list({ tickets: [] })))).toContain('No tickets here.');
  });

  it('falls back to the stored values for a product or status it has no name for', async () => {
    const page = await render(listPage(list({ tickets: [{ ...ticket, product_id: 'gone', status: 'odd' }] })));
    expect(page).toContain('<td>gone</td>');
    expect(page).toContain('<td>odd</td>');
  });
});

describe('the legal holds panel', () => {
  const T = Date.UTC(2026, 9, 1);
  const hold = {
    id: 'h1',
    attachmentId: null,
    reason: 'preservation' as const,
    csam: false,
    note: 'Request <1>',
    placedBy: 'rep@example.com',
    placedAt: T,
    earliest: Date.UTC(2026, 11, 30),
    orderPending: false,
    noReportReason: null,
  };
  const file = { id: 'a1', message_id: 'm1', mime: 'image/jpeg', bytes: 2000, duration_ms: null, state: 'stored', withheld: 0 as const };
  const message = { id: 'm1', author: 'customer', staff_email: null, body: 'Hi', created_at: 5 };

  it('shows a rep each live hold and the form to place one, but no admin actions', async () => {
    const page = await render(ticketPage(view({ messages: [message], attachments: [file], holds: { holds: [hold], report: null } })));
    expect(page).toContain('<h2 id="holds">Legal holds</h2>');
    expect(page).toContain(
      'Preservation request on the whole ticket: Request &lt;1&gt;. Placed by rep@example.com, 2026-10-01 00:00. May be lifted from 2026-12-30.',
    );
    expect(page).toContain('<form method="post" action="/desk/tickets/t1/holds">');
    expect(page).toContain('<option value="a1">Photo 1</option>');
    expect(page).not.toContain('/holds/h1/');
    expect(page).not.toContain('action="/desk/tickets/t1/authority-report"');
  });

  it('says what a hold covers: one file by its number, suspected child-abuse material, and one that cannot be lifted yet', async () => {
    const page = await render(
      ticketPage(
        view({
          messages: [message],
          attachments: [file],
          holds: { holds: [{ ...hold, reason: 'crime_unreported', attachmentId: 'a1', csam: true, earliest: null }], report: null },
        }),
      ),
    );
    expect(page).toContain('Possible crime, not yet reported, suspected child-abuse material, on Photo 1: ');
    expect(page).toContain('Cannot be lifted yet.');
  });

  it('names a held file that is withheld, or that the page does not list, without a number', async () => {
    const page = await render(
      ticketPage(
        view({
          messages: [message],
          attachments: [{ ...file, withheld: 1 }],
          holds: {
            holds: [
              { ...hold, attachmentId: 'a1' },
              { ...hold, id: 'h2', attachmentId: 'a9' },
            ],
            report: null,
          },
        }),
      ),
    );
    expect(page).toContain('Preservation request on a withheld file: ');
    expect(page).toContain('Preservation request on a file: ');
  });

  it('gives the admin lift, renew and order on a preservation hold, and the report form', async () => {
    const page = await render(ticketPage(view({ isAdmin: true, holds: { holds: [hold], report: null } })));
    expect(page).toContain('action="/desk/tickets/t1/holds/h1/lift"');
    expect(page).toContain('action="/desk/tickets/t1/holds/h1/renew"');
    expect(page).toContain('action="/desk/tickets/t1/holds/h1/order"');
    expect(page).toContain('<button type="submit">Mark a production order pending</button>');
    expect(page).not.toContain('/holds/h1/no-report');
    expect(page).toContain('action="/desk/tickets/t1/authority-report"');
  });

  it('gives the admin "no report needed" on an undecided possible crime, and "order answered" on a pending order', async () => {
    const page = await render(
      ticketPage(
        view({
          isAdmin: true,
          holds: {
            holds: [
              { ...hold, id: 'h2', reason: 'crime_unreported', earliest: null },
              { ...hold, id: 'h3', orderPending: true, earliest: null },
            ],
            report: null,
          },
        }),
      ),
    );
    expect(page).toContain('action="/desk/tickets/t1/holds/h2/no-report"');
    expect(page).not.toContain('/holds/h2/renew');
    expect(page).toContain('<button type="submit">Mark the order answered</button>');
    expect(page).toContain('Production order pending.');
  });

  it('gives no "no report needed" once that is recorded, and says why', async () => {
    const page = await render(
      ticketPage(
        view({ isAdmin: true, holds: { holds: [{ ...hold, reason: 'crime_unreported', noReportReason: 'A joke' }], report: null } }),
      ),
    );
    expect(page).not.toContain('/holds/h1/no-report');
    expect(page).toContain('No report needed: A joke.');
  });

  it('shows a recorded report in place of the form', async () => {
    const page = await render(
      ticketPage(
        view({
          isAdmin: true,
          holds: {
            holds: [hold],
            report: { reportedTo: 'Bareskrim Polri', reportedAt: T, reference: 'LP/1', recordedBy: 'admin@example.com' },
          },
        }),
      ),
    );
    expect(page).toContain('Reported to Bareskrim Polri on 2026-10-01, reference LP/1, recorded by admin@example.com.');
    expect(page).not.toContain('action="/desk/tickets/t1/authority-report"');
  });

  it.each([
    ['not_yet', 'This hold cannot be lifted yet.'],
    ['authority_report_owed', 'Record the report to the authorities before closing this ticket.'],
    ['basis_required', 'Enter the report or request date.'],
  ])('explains the refusal %s', async (error, text) => {
    expect(await render(ticketPage(view({ error, holds: { holds: [], report: null } })))).toContain(text);
  });

  it('confirms a hold action', async () => {
    expect(await render(ticketPage(view({ holdDone: 'placed', holds: { holds: [], report: null } })))).toContain('Legal hold placed.');
  });
});

describe('the legal review on the list', () => {
  it('shows the admin the tickets owing a report first, then the holds due for review, each linking to its ticket', async () => {
    const page = await render(
      listPage(
        list({
          legal: {
            duties: [{ ticketId: 't9', subject: 'Image <x>', placedAt: 1 }],
            due: [{ holdId: 'h1', ticketId: 't8', subject: 'Request', earliest: Date.UTC(2026, 10, 1) }],
          },
        }),
      ),
    );
    const duty = page.indexOf('<h2 id="legal-duty">Legal duty outstanding</h2>');
    const due = page.indexOf('<h2 id="holds-due">Holds due for review</h2>');
    expect(duty).toBeGreaterThan(-1);
    expect(due).toBeGreaterThan(duty);
    expect(page.indexOf('aria-label="Ticket list"')).toBeGreaterThan(due);
    expect(page).toContain('<a href="/desk/tickets/t9">Image &lt;x&gt;</a>: report to the authorities not yet recorded');
    expect(page).toContain('<a href="/desk/tickets/t8">Request</a>: may be lifted since 2026-11-01');
  });

  it('shows neither heading when nothing is owed or due', async () => {
    const page = await render(listPage(list({ legal: { duties: [], due: [] } })));
    expect(page).not.toContain('Legal duty outstanding');
    expect(page).not.toContain('Holds due for review');
  });
});

// A bare ticket row after its text timer (shyden-labs/shydesk#191): no subject, email or fields are left to show.
describe('a ticket whose text has gone', () => {
  const bare: DeskTicket = {
    ...ticket,
    status: 'closed',
    customer_email: '',
    subject: '',
    category: '',
    text_deleted_at: Date.UTC(2027, 10, 17),
  };

  it('reads "Text deleted" in the list instead of an empty link', async () => {
    expect(await render(listPage(list({ tickets: [bare] })))).toContain('<a href="/desk/tickets/t1">Text deleted</a>');
  });

  it('says when the text went, keeps the records, and offers no reply', async () => {
    const page = await render(ticketPage(view({ ticket: bare })));
    expect(page).toContain('<h1>Text deleted</h1>');
    expect(page).toContain('This ticket’s text was deleted on 2027-11-17 under its retention period; its records are kept.');
    expect(page).not.toContain('/desk/tickets/t1/reply');
  });

  it('says a reply was refused because the text has gone', async () => {
    expect(await render(ticketPage(view({ ticket: bare, error: 'text-deleted' })))).toContain(
      '<p role="status" aria-label="Reply status">This ticket’s text has been deleted, so it cannot be replied to.</p>',
    );
  });
});

describe('ticketPage', () => {
  const message = { id: 'm1', author: 'customer', staff_email: null, body: 'Help', created_at: 5 };
  const attachment = {
    id: 'a1',
    message_id: 'm1',
    mime: 'image/jpeg',
    bytes: 2000,
    duration_ms: null,
    state: 'stored',
    withheld: 0 as const,
  };

  it('names each stored attachment by kind and size, on its own message', async () => {
    const page = await render(
      ticketPage(
        view({
          messages: [message, { ...message, id: 'm2' }],
          attachments: [
            attachment,
            { ...attachment, id: 'a2', mime: 'video/mp4', bytes: 1001 },
            { ...attachment, id: 'a3', message_id: 'm3' },
          ],
        }),
      ),
    );
    expect(page).toContain('Photo 1, 2 KB');
    expect(page).toContain('Video 2, 2 KB');
    expect(page.match(/KB/g)).toHaveLength(2);
  });

  it('numbers the stored files only, so a removed one before them takes no number', async () => {
    const page = await render(
      ticketPage(
        view({
          messages: [message],
          attachments: [
            { ...attachment, id: 'a0', state: 'deleted' },
            { ...attachment, id: 'a1' },
          ],
        }),
      ),
    );
    expect(page).toContain('aria-label="Open photo 1"');
    expect(page).not.toContain('photo 2');
  });

  it('shows a file under a csam hold as withheld: no preview, no viewer, and it takes no number', async () => {
    // shyden-labs/shydesk#62 AC3.
    const page = await render(
      ticketPage(
        view({
          messages: [message],
          attachments: [
            { ...attachment, id: 'a0', withheld: 1 },
            { ...attachment, id: 'a1' },
          ],
        }),
      ),
    );
    expect(page).toContain('<li>Evidence withheld under legal hold</li>');
    expect(page).not.toContain('/desk/files/a0');
    expect(page).not.toContain('data-id="a0"');
    expect(page).toContain('aria-label="Open photo 1"');
    expect(page).not.toContain('photo 2');
  });

  it('names a staff message by its author, or plainly if none is recorded', async () => {
    const page = await render(
      ticketPage(
        view({
          messages: [
            { ...message, author: 'staff', staff_email: 'rep@example.com' },
            { ...message, id: 'm2', author: 'staff' },
          ],
        }),
      ),
    );
    expect(page).toContain('<strong>rep@example.com</strong>');
    expect(page).toContain('<strong>Staff</strong>');
  });

  it('offers no canned replies when there are none', async () => {
    expect(await render(ticketPage(view()))).not.toContain('Canned replies:');
  });

  it('offers closing an open ticket, not a closed one, which can still be answered', async () => {
    expect(await render(ticketPage(view()))).toContain('Close ticket');
    const closed = await render(ticketPage(view({ ticket: { ...ticket, status: 'closed' } })));
    expect(closed).not.toContain('Close ticket');
    expect(closed).toContain('Send reply');
    expect(closed).toContain('Closed ·');
  });

  // shyden-labs/shydesk#61: the appeal panel is drawn for the admin alone, whatever it is given.
  it('draws the appeal panel for the admin and never for anyone else', async () => {
    const appeal = {
      state: 'open',
      decided_by: null,
      decided_at: null,
      punishment_id: 'p1',
      label: 'Ban',
      lifted_at: null,
      report_ticket_id: 'r1',
    };
    expect(await render(ticketPage(view({ appeal, isAdmin: true })))).toContain('aria-label="Appeal"');
    expect(await render(ticketPage(view({ appeal, isAdmin: false })))).not.toContain('aria-label="Appeal"');
    expect(await render(ticketPage(view({ appeal })))).not.toContain('aria-label="Appeal"');
  });

  it('shows a status it has no name for as stored', async () => {
    expect(await render(ticketPage(view({ ticket: { ...ticket, status: 'odd' } })))).toContain('odd ·');
  });
});

describe('the queries', () => {
  it('starts the list from the first ticket with no cursor', async () => {
    const { db, statements } = standInDb();
    await listTickets(db, { products: ['shytalk'], role: 'rep' }, {});
    expect(statements[0]?.values.at(-1)).toBe(0);
  });

  it('asks nothing for no products', async () => {
    const { db, statements } = standInDb();
    const none = { products: [], role: 'admin' as const };
    expect(await listTickets(db, none, {})).toEqual([]);
    expect(await getTicket(db, none, 't1')).toBeNull();
    expect(await getFile(db, none, 'a1')).toBeNull();
    expect(await unreadCount(db, 'a@b.c', none)).toBe(0);
    expect(statements).toEqual([]);
  });

  it('counts nothing if the count answers no row', async () => {
    expect(await unreadCount(standInDb().db, 'a@b.c', { products: ['shytalk'], role: 'rep' })).toBe(0);
  });

  // shyden-labs/shydesk#61 AC2: a rep never sees an appeal, not its ticket, its files, nor a count.
  // The SQL itself is proven on real D1 in tests/integration/appeals.test.ts.
  const NOT_APPEAL = "type_id IN (SELECT id FROM ticket_types WHERE kind != 'appeal')";
  const asked = async (
    role: 'admin' | 'rep',
    ask: (db: ReturnType<typeof standInDb>['db'], scope: { products: string[]; role: 'admin' | 'rep' }) => Promise<unknown>,
  ) => {
    const { db, statements } = standInDb();
    await ask(db, { products: ['shytalk'], role });
    return statements[0]?.sql ?? '';
  };

  it("leaves appeals out of a rep's list, in SQL, and keeps them in the admin's", async () => {
    expect(await asked('rep', (db, scope) => listTickets(db, scope, {}))).toContain(NOT_APPEAL);
    expect(await asked('admin', (db, scope) => listTickets(db, scope, {}))).not.toContain('appeal');
  });

  it("leaves appeals out of a rep's ticket lookup and keeps them in the admin's", async () => {
    expect(await asked('rep', (db, scope) => getTicket(db, scope, 't1'))).toContain(NOT_APPEAL);
    expect(await asked('admin', (db, scope) => getTicket(db, scope, 't1'))).not.toContain('appeal');
  });

  it("leaves an appeal's files out of a rep's file lookup and keeps them in the admin's", async () => {
    expect(await asked('rep', (db, scope) => getFile(db, scope, 'a1'))).toContain(`t.${NOT_APPEAL}`);
    expect(await asked('admin', (db, scope) => getFile(db, scope, 'a1'))).not.toContain('appeal');
  });

  it('withholds a file under a live csam hold, on the ticket or on that file, from every viewer, in SQL', async () => {
    // shyden-labs/shydesk#62: suspected child-abuse material is never served, the admin included.
    expect(await asked('rep', (db, scope) => getFile(db, scope, 'a1'))).toMatch(
      /NOT EXISTS \(SELECT 1 FROM legal_holds h WHERE h\.lifted_at IS NULL AND h\.csam = 1 AND h\.ticket_id = a\.ticket_id AND \(h\.attachment_id IS NULL OR h\.attachment_id = a\.id\)\)/,
    );
    expect(await asked('admin', (db, scope) => getFile(db, scope, 'a1'))).toMatch(
      /NOT EXISTS \(SELECT 1 FROM legal_holds h WHERE h\.lifted_at IS NULL AND h\.csam = 1 AND h\.ticket_id = a\.ticket_id AND \(h\.attachment_id IS NULL OR h\.attachment_id = a\.id\)\)/,
    );
  });

  it('marks each attachment of a ticket withheld when a live csam hold covers it, in SQL', async () => {
    const { db, statements } = standInDb((sql) => (sql.includes('FROM tickets') ? [{ ...ticket }] : []));
    await getTicket(db, { products: ['shytalk'], role: 'admin' }, 't1');
    const files = statements.find((s) => s.sql.includes('FROM attachments'))?.sql;
    expect(files).toMatch(/FROM attachments a WHERE/);
    expect(files).toMatch(
      /CASE WHEN NOT EXISTS \(SELECT 1 FROM legal_holds h WHERE h\.lifted_at IS NULL AND h\.csam = 1 AND h\.ticket_id = a\.ticket_id AND \(h\.attachment_id IS NULL OR h\.attachment_id = a\.id\)\) THEN 0 ELSE 1 END AS withheld/,
    );
  });

  it("leaves appeals out of a rep's unread count and keeps them in the admin's", async () => {
    expect(await asked('rep', (db, scope) => unreadCount(db, 'r@b.c', scope))).toContain(`t.${NOT_APPEAL}`);
    expect(await asked('admin', (db, scope) => unreadCount(db, 'a@b.c', scope))).not.toContain('appeal');
  });

  it('gives an admin a staff row before marking read, and a rep none', async () => {
    const admin = standInDb();
    await markRead(admin.db, { email: 'a@b.c', role: 'admin', products: [] }, 't1', 9);
    expect(admin.statements.map((s) => s.sql.includes('INTO staff'))).toEqual([true, false]);
    expect(admin.statements[0]?.values).toEqual(['a@b.c', 9]);
    const rep = standInDb();
    await markRead(rep.db, { email: 'a@b.c', role: 'rep', products: [] }, 't1');
    expect(rep.statements.map((s) => s.sql.includes('INTO staff'))).toEqual([false]);
  });
});

// A notice that bounced shows on its ticket and marks the list (shyden-labs/shydesk#232).
describe('bounced notices', () => {
  const AT = Date.UTC(2026, 10, 20, 1, 2);
  const messages = [
    { id: 'm1', author: 'customer', staff_email: null, body: 'Help', created_at: 1 },
    { id: 'm2', author: 'staff', staff_email: 'rep@example.com', body: 'Fixed', created_at: 2 },
  ];
  const bounced = (over: Partial<DeskNotice> = {}): DeskNotice => ({
    message_id: 'm2',
    to_address: 'a@b.example',
    bounced_at: AT,
    bounce_status: '5.1.1',
    bounce_reason: '550 5.1.1 user unknown',
    ...over,
  });
  const articles = async (notices: DeskNotice[]) => (await render(ticketPage(view({ messages, notices })))).split('<article>').slice(1);

  it("shows a bounced reply notice inside that reply's article", async () => {
    const [first, second] = await articles([bounced()]);
    expect(second).toContain(
      '<p role="alert">Email to a@b.example bounced at 2026-11-20 01:02. Reason given in the failure report (not checked by ShyDesk): 550 5.1.1 user unknown</p>',
    );
    expect(first).not.toContain('bounced');
  });

  it('shows a bounced new-ticket notice (no message) under the first message', async () => {
    const [first, second] = await articles([bounced({ message_id: null })]);
    expect(first).toContain(
      'Email to a@b.example bounced at 2026-11-20 01:02. Reason given in the failure report (not checked by ShyDesk): 550 5.1.1 user unknown',
    );
    expect(second).not.toContain('bounced');
  });

  it('falls back to the status when the reason is empty', async () => {
    const [, second] = await articles([bounced({ bounce_reason: '' })]);
    expect(second).toContain(
      'Email to a@b.example bounced at 2026-11-20 01:02. Reason given in the failure report (not checked by ShyDesk): 5.1.1</p>',
    );
  });

  it('shows the reason as text, never as markup', async () => {
    const [, second] = await articles([bounced({ bounce_reason: '<script>x</script>' })]);
    expect(second).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(second).not.toContain('<script>');
  });

  it('shows nothing when no notice bounced', async () => {
    expect(await render(ticketPage(view({ messages, notices: [] })))).not.toContain('bounced');
  });

  // shyden-labs/shydesk#263 AC2: a TEST site's ticket is never mistaken for a live customer's.
  it('marks a TEST ticket TEST in the list, and a live one not', async () => {
    const marked = await render(listPage(list({ tickets: [{ ...ticket, test_origin: 'https://test.shytalk.app' }] })));
    expect(marked).toContain('<td><strong class="test-mark">TEST</strong> <a href="/desk/tickets/t1">Sign in</a></td>');
    expect(await render(listPage(list()))).not.toContain('class="test-mark"');
  });

  it('names the TEST site on a TEST ticket page, and nothing on a live one', async () => {
    const page = await render(ticketPage(view({ ticket: { ...ticket, test_origin: 'https://test.shytalk.app' } })));
    expect(page).toMatch(
      /<p role="note" aria-label="TEST ticket">\s*<strong class="test-mark">TEST<\/strong> From the TEST site https:\/\/test\.shytalk\.app\. Live tickets come first\.\s*<\/p>/,
    );
    expect(await render(ticketPage(view()))).not.toContain('class="test-mark"');
  });

  it('reads the TEST site with every ticket it lists or opens', async () => {
    const { db, statements } = standInDb();
    await listTickets(db, { products: ['shytalk'], role: 'admin' }, {});
    await getTicket(db, { products: ['shytalk'], role: 'admin' }, 't1');
    expect(statements[0]?.sql).toContain('text_deleted_at, test_origin, ');
    expect(statements[1]?.sql).toContain('text_deleted_at, test_origin, ');
  });

  it('marks the list "Email bounced" only when the latest notice bounced', async () => {
    const marked = await render(listPage(list({ tickets: [{ ...ticket, last_notice_bounced: 1 }] })));
    expect(marked).toContain('Email bounced');
    expect(await render(listPage(list({ tickets: [{ ...ticket, last_notice_bounced: 0 }] })))).not.toContain('Email bounced');
  });

  it('reads the bounced notices with the ticket, and the latest notice with each list row', async () => {
    const { db, statements } = standInDb((sql): Record<string, unknown>[] =>
      sql.includes('FROM notices WHERE') ? [{ ...bounced() }] : sql.includes('FROM tickets') ? [{ ...ticket }] : [],
    );
    const found = await getTicket(db, { products: ['shytalk'], role: 'admin' }, 't1');
    expect(found?.notices).toEqual([bounced()]);
    const notices = statements.find((s) => s.sql.includes('FROM notices WHERE'));
    expect(notices?.sql).toContain('bounced_at IS NOT NULL');
    expect(notices?.values).toEqual(['t1']);
    const { db: listDb, statements: listed } = standInDb();
    await listTickets(listDb, { products: ['shytalk'], role: 'admin' }, {});
    expect(listed[0]?.sql).toContain('ORDER BY n.sent_at DESC, n.rowid DESC LIMIT 1), 0) AS last_notice_bounced');
  });
});
