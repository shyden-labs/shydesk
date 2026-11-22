// Failed delivery reports on a real D1 database (shyden-labs/shydesk#232): the first report for a notice is
// recorded and a second is rejected, leaving the first; a report for a notice whose ticket text was deleted
// finds no row and is rejected.
import { describe, expect, inject, it, vi } from 'vitest';
import { handleBounce, type BounceMessage } from '../../src/mail/bounces.ts';
import { saveProduct, saveTicketType, supportTypeId } from '../../src/products.ts';
import { deleteText } from '../../src/timers/retention.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const DOMAIN = 'bounce.example';

const report = (status: string, reason: string) =>
  [
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; relay.example',
    '',
    'Final-Recipient: rfc822; gone@gmail.com',
    'Action: failed',
    `Status: ${status}`,
    `Diagnostic-Code: smtp; ${reason}`,
    '',
    '--B--',
    '',
  ].join('\r\n');

function message(id: string, raw: string) {
  const setReject = vi.fn<(reason: string) => void>();
  const m = {
    to: `bounce-${id}@${DOMAIN}`,
    from: 'MAILER-DAEMON@relay.example',
    rawSize: raw.length,
    setReject,
  } as unknown as BounceMessage;
  Object.defineProperty(m, 'raw', { get: () => new Response(raw).body });
  return { m, setReject };
}

async function seed(ticketId: string, noticeId: string, status: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, closed_at, seq)
       VALUES (?, 'it-bn', ?, ?, 'pat@example.com', 'Subject', 'bug', '{}', ?, 1000, 1000, ?, 0)`,
    )
    .bind(ticketId, supportTypeId('it-bn'), status, `hash-${ticketId}`, status === 'closed' ? 1000 : null)
    .run();
  await db
    .prepare("INSERT INTO notices (id, ticket_id, message_id, to_address, sent_at) VALUES (?, ?, NULL, 'pat@example.com', 1000)")
    .bind(noticeId, ticketId)
    .run();
}

const notice = (id: string) => db.prepare('SELECT bounced_at, bounce_status, bounce_reason FROM notices WHERE id = ?').bind(id).first();

describe('bounces on D1', () => {
  it('records the first report for a notice, rejects a second and a report for a notice whose text went', async () => {
    await saveProduct(
      db,
      {
        id: 'it-bn',
        name: 'Product it-bn',
        senderAddress: 'no-reply@it-bn.example',
        ticketPageUrl: 'https://it-bn.example/ticket',
        allowedOrigins: ['https://it-bn.example'],
        monthlyEmailShare: 100,
        attachmentsKeepDays: 30,
        textKeepDays: 365,
      },
      1000,
    );
    await saveTicketType(db, { productId: 'it-bn', name: 'Support', fields: [] });
    const first = '1a1a1a1a-0000-4000-8000-000000000001';
    const gone = '1a1a1a1a-0000-4000-8000-000000000002';
    await seed('it-bn-t1', first, 'open');
    await seed('it-bn-t2', gone, 'closed');
    const env = { DB: db, BOUNCE_DOMAIN: DOMAIN };

    const one = message(first, report('5.1.1', '550 5.1.1 user unknown'));
    await handleBounce(one.m, env, 2000);
    expect.soft(one.setReject).not.toHaveBeenCalled();
    const two = message(first, report('5.7.1', '550 5.7.1 blocked'));
    await handleBounce(two.m, env, 3000);
    expect.soft(two.setReject).toHaveBeenCalledWith('unknown notice');
    expect.soft(await notice(first)).toEqual({ bounced_at: 2000, bounce_status: '5.1.1', bounce_reason: '550 5.1.1 user unknown' });

    await deleteText(db, undefined, 'it-bn-t2', 5000);
    expect.soft(await notice(gone)).toBeNull();
    const late = message(gone, report('5.1.1', '550 5.1.1 user unknown'));
    await handleBounce(late.m, env, 6000);
    expect.soft(late.setReject).toHaveBeenCalledWith('unknown notice');
    expect.soft(await notice(gone)).toBeNull();
    vi.restoreAllMocks();
  });
});
