// Notice rows on a real D1 database (shyden-labs/shydesk#232): with a bounce
// domain each notice is written down against its ticket, naming the reply
// message it announces or none for a new ticket, and a failed send leaves no row.
import { describe, expect, inject, it, vi } from 'vitest';
import { sendNoReply, type Deliver, type MailEnv } from '../../src/mail/notify.ts';
import { getTicket } from '../../src/desk/queries.ts';
import { getProduct, saveProduct, saveTicketType, supportTypeId, type Product } from '../../src/products.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const NOW = new Date('2026-11-20T01:00:00Z');
const LINK = 'https://it-nt.example/ticket#ticket=abc';
const SENDER = 'no-reply@it-nt.example';
const env: MailEnv = {
  DB: db,
  SMTP_LOGINS: JSON.stringify({ [SENDER]: { user: 'u', pass: 'p' } }),
  SMTP_HOST: 'mail.example',
  BOUNCE_DOMAIN: 'bounce.example',
};

async function seed(id = 'it-nt'): Promise<Product> {
  await saveProduct(
    db,
    {
      id,
      name: `Product ${id}`,
      senderAddress: SENDER,
      ticketPageUrl: 'https://it-nt.example/ticket',
      allowedOrigins: ['https://it-nt.example'],
      monthlyEmailShare: 100,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    1000,
  );
  await saveTicketType(db, { productId: id, name: 'Support', fields: [] });
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq)
       VALUES (?, ?, ?, 'open', 'pat@example.com', 'Subject', 'bug', '{}', ?, 1000, 1000, 0)`,
    )
    .bind(`${id}-t1`, id, supportTypeId(id), `hash-${id}-t1`)
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES (?, ?, 'staff', 'rep@example.com', 'Hi', 1000)",
    )
    .bind(`${id}-m1`, `${id}-t1`)
    .run();
  const product = await getProduct(db, id);
  if (product === null) throw new Error(`seeded product ${id} was not read back`);
  return product;
}

const rows = async () =>
  (
    await db
      .prepare('SELECT id, ticket_id, message_id, to_address, sent_at, bounced_at FROM notices WHERE ticket_id = ? ORDER BY message_id')
      .bind('it-nt-t1')
      .all()
  ).results;

describe('notice rows', () => {
  it('a reply notice row names its message, a new-ticket notice row has message_id null, and a failed send leaves none', async () => {
    const product = await seed();
    const deliver = vi.fn<Deliver>(() => Promise.resolve());
    const fails = vi.fn<Deliver>(() => Promise.reject(new Error('SMTP rcpt failed: 550 no such user')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW, { ticketId: 'it-nt-t1', messageId: null })).resolves.toBe(
      'sent',
    );
    await expect(
      sendNoReply(env, product, 'pat@example.com', LINK, deliver, NOW, { ticketId: 'it-nt-t1', messageId: 'it-nt-m1' }),
    ).resolves.toBe('sent');
    await expect(
      sendNoReply(env, product, 'pat@example.com', LINK, fails, NOW, { ticketId: 'it-nt-t1', messageId: 'it-nt-m1' }),
    ).resolves.toBe('failed');

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.map(({ message_id, to_address, sent_at, bounced_at }) => ({ message_id, to_address, sent_at, bounced_at }))).toEqual([
      { message_id: null, to_address: 'pat@example.com', sent_at: NOW.getTime(), bounced_at: null },
      { message_id: 'it-nt-m1', to_address: 'pat@example.com', sent_at: NOW.getTime(), bounced_at: null },
    ]);
    const envelopes = deliver.mock.calls.map((call) => call[1].envelopeFrom);
    expect(envelopes).toEqual(stored.map((r) => `bounce-${String(r.id)}@bounce.example`));
    vi.restoreAllMocks();
  });

  // shyden-labs/shydesk#274 AC1: the desk reads why a new ticket's first email did not go.
  it("notes a new ticket's first email that did not go, and the desk reads it with the ticket", async () => {
    const product = await seed('it-nu');
    const fails = vi.fn<Deliver>(() => Promise.reject(new Error('SMTP rcpt failed: 550 no such user')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scope = { products: ['it-nu'], role: 'rep' as const };
    const first = { ticketId: 'it-nu-t1', messageId: null };

    await expect(sendNoReply(env, product, 'pat@example.com', LINK, fails, NOW, first)).resolves.toBe('failed');
    expect.soft((await getTicket(db, scope, 'it-nu-t1'))?.ticket.first_notice_unsent).toBe('failed');

    await expect(sendNoReply(env, { ...product, monthlyEmailShare: 0 }, 'pat@example.com', LINK, fails, NOW, first)).resolves.toBe(
      'share-used-up',
    );
    expect.soft((await getTicket(db, scope, 'it-nu-t1'))?.ticket.first_notice_unsent).toBe('share-used-up');
    vi.restoreAllMocks();
  });
});
