import { describe, expect, it } from 'vitest';
import { getFile, getTicket, listTickets, markRead, unreadCount, type DeskTicket } from '../../src/desk/queries.ts';
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

describe('ticketPage', () => {
  const message = { id: 'm1', author: 'customer', staff_email: null, body: 'Help', created_at: 5 };
  const attachment = { id: 'a1', message_id: 'm1', mime: 'image/jpeg', bytes: 2000, duration_ms: null, state: 'stored' };

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
