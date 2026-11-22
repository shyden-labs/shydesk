// Notice rows on a real D1 database (shyden-labs/shydesk#232): with a bounce
// domain each notice is written down against its ticket, naming the reply
// message it announces or none for a new ticket, and a failed send leaves no row.
import { describe, expect, inject, it, vi } from 'vitest';
import { sendNoReply, type Deliver, type MailEnv } from '../../src/mail/notify.ts';
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

async function seed(): Promise<Product> {
  await saveProduct(
    db,
    {
      id: 'it-nt',
      name: 'Product it-nt',
      senderAddress: SENDER,
      ticketPageUrl: 'https://it-nt.example/ticket',
      allowedOrigins: ['https://it-nt.example'],
      monthlyEmailShare: 100,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    1000,
  );
  await saveTicketType(db, { productId: 'it-nt', name: 'Support', fields: [] });
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, seq)
       VALUES ('it-nt-t1', 'it-nt', ?, 'open', 'pat@example.com', 'Subject', 'bug', '{}', 'hash-it-nt-t1', 1000, 1000, 0)`,
    )
    .bind(supportTypeId('it-nt'))
    .run();
  await db
    .prepare(
      "INSERT INTO messages (id, ticket_id, author, staff_email, body, created_at) VALUES ('it-nt-m1', 'it-nt-t1', 'staff', 'rep@example.com', 'Hi', 1000)",
    )
    .run();
  const product = await getProduct(db, 'it-nt');
  if (product === null) throw new Error('seeded product it-nt was not read back');
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
});
