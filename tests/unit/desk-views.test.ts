import { describe, expect, it } from 'vitest';
import { getTicket, listTickets, markRead, unreadCount, type DeskTicket } from '../../src/desk/queries.ts';
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
    expect(page).toContain('Photo, 2 KB');
    expect(page).toContain('Video, 2 KB');
    expect(page.match(/KB/g)).toHaveLength(2);
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

  it('shows a status it has no name for as stored', async () => {
    expect(await render(ticketPage(view({ ticket: { ...ticket, status: 'odd' } })))).toContain('odd ·');
  });
});

describe('the queries', () => {
  it('starts the list from the first ticket with no cursor', async () => {
    const { db, statements } = standInDb();
    await listTickets(db, ['shytalk'], {});
    expect(statements[0]?.values.at(-1)).toBe(0);
  });

  it('asks nothing for no products', async () => {
    const { db, statements } = standInDb();
    expect(await listTickets(db, [], {})).toEqual([]);
    expect(await getTicket(db, [], 't1')).toBeNull();
    expect(await unreadCount(db, 'a@b.c', [])).toBe(0);
    expect(statements).toEqual([]);
  });

  it('counts nothing if the count answers no row', async () => {
    expect(await unreadCount(standInDb().db, 'a@b.c', ['shytalk'])).toBe(0);
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
