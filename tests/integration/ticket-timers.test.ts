// Ticket timers' SQL on a real D1 database with the Release 1 schema
// (shyden-labs/shydesk#22): a status change moves the ticket to the next feed
// seq and only from the expected status; retention deletes only while the
// ticket is closed; the overdue panel lists exactly what is past due. R2 is not
// enabled yet (shyden-labs/shydesk#35), so object deletes go to a recorder.
import { describe, expect, inject, it } from 'vitest';
import { overdue } from '../../src/desk/overdue.ts';
import { saveProduct, saveTicketType, supportTypeId } from '../../src/products.ts';
import { STORED_BYTES, storedBytes } from '../../src/storage.ts';
import { DAY_MS, writeStatus } from '../../src/tickets/status.ts';
import { deleteAttachments, deleteText } from '../../src/timers/retention.ts';
import { restD1 } from './d1.ts';

const db = restD1(inject('databaseId'));
const NOW = Date.UTC(2026, 10, 6, 12);

async function product(id: string, attachmentsKeepDays = 30, textKeepDays = 365): Promise<void> {
  await saveProduct(
    db,
    {
      id,
      name: `Product ${id}`,
      senderAddress: `no-reply@${id}.example`,
      ticketPageUrl: `https://${id}.example/ticket`,
      allowedOrigins: [`https://${id}.example`],
      monthlyEmailShare: 100,
      attachmentsKeepDays,
      textKeepDays,
    },
    1000,
  );
  await saveTicketType(db, { productId: id, name: 'Support', fields: [] });
}

async function ticket(productId: string, id: string, status: string, updatedAt: number, closedAt: number | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tickets (id, product_id, type_id, status, customer_email, subject, category, fields_json, token_hash, created_at, updated_at, closed_at, seq)
       VALUES (?, ?, ?, ?, 'someone@example.com', 'Subject', 'bug', '{}', ?, 1000, ?, ?, 0)`,
    )
    .bind(id, productId, supportTypeId(productId), status, `hash-${id}`, updatedAt, closedAt)
    .run();
}

async function attachment(
  productId: string,
  id: string,
  ticketId: string | null,
  state: string,
  bytes: number,
  createdAt = 1000,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attachments (id, product_id, ticket_id, r2_key, thumb_key, mime, bytes, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, ?, ?)`,
    )
    .bind(id, productId, ticketId, `k-${id}`, `th-${id}`, bytes, state, createdAt)
    .run();
}

/** A rep who has opened the ticket, as the desk records it (src/desk/queries.ts). */
const staffRead = async (email: string, ticketId: string) => {
  await db.prepare(`INSERT INTO staff (email, role, created_at) VALUES (?, 'rep', 1000)`).bind(email).run();
  await db.prepare(`INSERT INTO reads (email, ticket_id, read_seq) VALUES (?, ?, 1)`).bind(email, ticketId).run();
};

/** A legal hold on a ticket, or on one of its attachments (migrations/0004_release_2.sql); lifted when `liftedAt` is set. */
async function hold(id: string, ticketId: string, attachmentId: string | null, liftedAt: number | null = null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO legal_holds (id, ticket_id, attachment_id, reason, csam, note, placed_by, placed_at, lifted_at, lifted_by)
       VALUES (?, ?, ?, 'crime_unreported', 0, 'Possible threat.', 'rep@example.com', 1000, ?, ?)`,
    )
    .bind(id, ticketId, attachmentId, liftedAt, liftedAt === null ? null : 'admin@example.com')
    .run();
}

const one = async (sql: string, ...values: unknown[]) =>
  db
    .prepare(sql)
    .bind(...values)
    .first();

function recorder() {
  const deleted: string[][] = [];
  return {
    deleted,
    files: {
      delete: (keys: string | string[]) => {
        deleted.push([keys].flat());
        return Promise.resolve();
      },
    },
  };
}

describe('writeStatus on D1', () => {
  it('closes a ticket at the next feed seq and returns its keep-days', async () => {
    await product('it-tm-status', 2, 3);
    await ticket('it-tm-status', 'it-tm-s1', 'open', 1000, null);
    const before = (await one(`SELECT value FROM counters WHERE key = 'feed_seq'`))?.value ?? 0;
    expect(await writeStatus(db, 'it-tm-s1', 'closed', NOW)).toEqual({ attachmentsKeepDays: 2, textKeepDays: 3 });
    const row = await one('SELECT status, updated_at, closed_at, seq FROM tickets WHERE id = ?', 'it-tm-s1');
    expect(row).toMatchObject({ status: 'closed', updated_at: NOW, closed_at: NOW });
    expect(row?.seq).toBe(Number(before) + 1);
  });

  it('leaves a ticket not in the expected status alone', async () => {
    await product('it-tm-from');
    await ticket('it-tm-from', 'it-tm-f1', 'open', 1000, null);
    expect(await writeStatus(db, 'it-tm-f1', 'closed', NOW, 'waiting')).toBeNull();
    expect(await one('SELECT status FROM tickets WHERE id = ?', 'it-tm-f1')).toEqual({ status: 'open' });
  });
});

describe('retention on D1', () => {
  it('deletes a closed ticket’s stored attachments and takes their bytes off the total', async () => {
    await product('it-tm-att');
    await ticket('it-tm-att', 'it-tm-a1', 'closed', 1000, 1000);
    await attachment('it-tm-att', 'it-tm-x1', 'it-tm-a1', 'stored', 100);
    await attachment('it-tm-att', 'it-tm-x2', 'it-tm-a1', 'stored', 50);
    await db
      .prepare(`INSERT INTO counters (key, value) VALUES (?, 150) ON CONFLICT (key) DO UPDATE SET value = value + 150`)
      .bind(STORED_BYTES)
      .run();
    const before = await storedBytes(db);
    const { deleted, files } = recorder();
    await deleteAttachments(db, files, 'it-tm-a1', NOW);
    expect(deleted.flat().sort()).toEqual(['k-it-tm-x1', 'k-it-tm-x2', 'th-it-tm-x1', 'th-it-tm-x2']);
    expect(
      await one(`SELECT COUNT(*) AS n FROM attachments WHERE ticket_id = ? AND state = 'deleted' AND deleted_at = ?`, 'it-tm-a1', NOW),
    ).toEqual({ n: 2 });
    expect(await storedBytes(db)).toBe(before - 150);
  });

  it('leaves a reopened ticket’s attachments and text alone', async () => {
    await product('it-tm-open');
    await ticket('it-tm-open', 'it-tm-o1', 'open', 1000, null);
    await attachment('it-tm-open', 'it-tm-y1', 'it-tm-o1', 'stored', 10);
    await staffRead('it-tm-rep-o@example.com', 'it-tm-o1');
    const { deleted, files } = recorder();
    await deleteText(db, files, 'it-tm-o1', NOW);
    expect(deleted).toEqual([]);
    expect(await one('SELECT read_seq FROM reads WHERE ticket_id = ?', 'it-tm-o1')).toEqual({ read_seq: 1 });
    expect(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-y1')).toEqual({ state: 'stored' });
    expect(await one('SELECT status FROM tickets WHERE id = ?', 'it-tm-o1')).toEqual({ status: 'open' });
  });

  // A ticket staff have opened carries their read marks, which reference it (shyden-labs/shydesk#119).
  it('deletes a closed ticket’s text: its attachments, messages, staff read marks and the ticket', async () => {
    await product('it-tm-text');
    await ticket('it-tm-text', 'it-tm-t1', 'closed', 1000, 1000);
    await db
      .prepare(`INSERT INTO messages (id, ticket_id, author, body, created_at) VALUES ('it-tm-m1', 'it-tm-t1', 'customer', 'Hello', 1000)`)
      .run();
    await attachment('it-tm-text', 'it-tm-z1', 'it-tm-t1', 'deleted', 5);
    await staffRead('it-tm-rep-t@example.com', 'it-tm-t1');
    await deleteText(db, recorder().files, 'it-tm-t1', NOW);
    expect(await one('SELECT id FROM tickets WHERE id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT id FROM messages WHERE ticket_id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT id FROM attachments WHERE ticket_id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT email FROM reads WHERE ticket_id = ?', 'it-tm-t1')).toBeNull();
    expect(await one('SELECT email FROM staff WHERE email = ?', 'it-tm-rep-t@example.com')).toEqual({ email: 'it-tm-rep-t@example.com' });
  });

  // Release 2 records point at report and appeal tickets (shyden-labs/shydesk#191). Shyden's ruling 2026-11-17: the
  // text goes on time, and a bare ticket row (ID, product, type, status, dates) stays so the report's subject,
  // punishments, appeal outcomes, legal-hold logs and authority reports survive.
  it('keeps a bare ticket row, and every record pointing at it, when the text of a report or appeal ticket goes', async () => {
    await product('it-tm-bare');
    await ticket('it-tm-bare', 'it-tm-r1', 'closed', 1000, 1000);
    await ticket('it-tm-bare', 'it-tm-p1', 'closed', 1000, 1000);
    await db.prepare(`UPDATE tickets SET token_sealed = 'sealed' WHERE id IN ('it-tm-r1', 'it-tm-p1')`).run();
    await db
      .prepare(
        `INSERT INTO messages (id, ticket_id, author, body, created_at) VALUES ('it-tm-rm1', 'it-tm-r1', 'customer', 'They spammed me', 1000)`,
      )
      .run();
    await attachment('it-tm-bare', 'it-tm-ra1', 'it-tm-r1', 'deleted', 5);
    await attachment('it-tm-bare', 'it-tm-ra2', 'it-tm-r1', 'deleted', 5);
    await db.prepare(`UPDATE attachments SET message_id = 'it-tm-rm1' WHERE id IN ('it-tm-ra1', 'it-tm-ra2')`).run();
    await staffRead('it-tm-rep-r@example.com', 'it-tm-r1');
    await db
      .prepare(
        `INSERT INTO reports (ticket_id, product_id, reporter_id, item_kind, item_id, subject_user_id, reason, context_json)
         VALUES ('it-tm-r1', 'it-tm-bare', 'reporter-1', 'message', 'item-1', 'subject-1', 'spam', '{"text":"buy now"}')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO punishments (id, product_id, report_ticket_id, subject_user_id, punishment_key, label, applied_by, created_at, send_state, appeal_token_hash)
         VALUES ('it-tm-pun1', 'it-tm-bare', 'it-tm-r1', 'subject-1', 'mute', 'Mute', 'admin@example.com', 1000, 'applied', 'appeal-hash-it-tm')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO appeals (punishment_id, ticket_id, state, decided_by, decided_at) VALUES ('it-tm-pun1', 'it-tm-p1', 'rejected', 'admin@example.com', 1000)`,
      )
      .run();
    // A lifted hold on one attachment, with its log: the hold no longer stops deletion, but its record stays.
    await db
      .prepare(
        `INSERT INTO legal_holds (id, ticket_id, attachment_id, reason, csam, note, placed_by, placed_at, lifted_at, lifted_by)
         VALUES ('it-tm-h1', 'it-tm-r1', 'it-tm-ra1', 'preservation', 0, 'Police request', 'admin@example.com', 1000, 2000, 'admin@example.com')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO legal_hold_events (hold_id, at, by, action, detail) VALUES ('it-tm-h1', 2000, 'admin@example.com', 'lifted', 'Done')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO authority_reports (ticket_id, reported_to, reported_at, reference, recorded_by, recorded_at)
         VALUES ('it-tm-r1', 'Police', 1500, 'REF-1', 'admin@example.com', 1500)`,
      )
      .run();

    await deleteText(db, recorder().files, 'it-tm-r1', NOW);
    await deleteText(db, recorder().files, 'it-tm-p1', NOW);

    for (const id of ['it-tm-r1', 'it-tm-p1']) {
      const row = await one(
        `SELECT product_id, type_id, status, customer_email, subject, category, fields_json, token_sealed, created_at, closed_at, text_deleted_at,
                token_hash = ? AS same_hash
         FROM tickets WHERE id = ?`,
        `hash-${id}`,
        id,
      );
      expect(row).toEqual({
        product_id: 'it-tm-bare',
        type_id: supportTypeId('it-tm-bare'),
        status: 'closed',
        customer_email: '',
        subject: '',
        category: '',
        fields_json: '{}',
        token_sealed: null,
        created_at: 1000,
        closed_at: 1000,
        text_deleted_at: NOW,
        same_hash: 0,
      });
    }
    expect(await one('SELECT COUNT(*) AS n FROM messages WHERE ticket_id = ?', 'it-tm-r1')).toEqual({ n: 0 });
    expect(await one('SELECT COUNT(*) AS n FROM reads WHERE ticket_id = ?', 'it-tm-r1')).toEqual({ n: 0 });
    // The held attachment's row stays for its hold's record, detached from the deleted message; the other goes.
    expect(await one('SELECT id, state, message_id FROM attachments WHERE ticket_id = ?', 'it-tm-r1')).toEqual({
      id: 'it-tm-ra1',
      state: 'deleted',
      message_id: null,
    });
    // The report's text goes; who and what was reported stays for repeat-offender history.
    expect(
      await one(
        'SELECT reporter_id, item_kind, item_id, subject_user_id, reason, context_json FROM reports WHERE ticket_id = ?',
        'it-tm-r1',
      ),
    ).toEqual({ reporter_id: '', item_kind: 'message', item_id: 'item-1', subject_user_id: 'subject-1', reason: '', context_json: '{}' });
    expect(await one('SELECT report_ticket_id, label FROM punishments WHERE id = ?', 'it-tm-pun1')).toEqual({
      report_ticket_id: 'it-tm-r1',
      label: 'Mute',
    });
    expect(await one('SELECT ticket_id, state FROM appeals WHERE punishment_id = ?', 'it-tm-pun1')).toEqual({
      ticket_id: 'it-tm-p1',
      state: 'rejected',
    });
    expect(await one('SELECT note, lifted_at FROM legal_holds WHERE id = ?', 'it-tm-h1')).toEqual({
      note: 'Police request',
      lifted_at: 2000,
    });
    expect(await one('SELECT COUNT(*) AS n FROM legal_hold_events WHERE hold_id = ?', 'it-tm-h1')).toEqual({ n: 1 });
    expect(await one('SELECT reference FROM authority_reports WHERE ticket_id = ?', 'it-tm-r1')).toEqual({ reference: 'REF-1' });
    // A bare ticket is never due again, and can never be reopened.
    expect((await overdue(db, NOW + 400 * DAY_MS)).filter((o) => o.id === 'it-tm-r1' || o.id === 'it-tm-p1')).toEqual([]);
    expect(await writeStatus(db, 'it-tm-r1', 'open', NOW)).toBeNull();
    expect(await one('SELECT status FROM tickets WHERE id = ?', 'it-tm-r1')).toEqual({ status: 'closed' });
  });
});

// Held evidence is never deleted automatically (shyden-labs/shydesk#62 AC1).
describe('retention under a legal hold on D1', () => {
  it('deletes a closed ticket’s attachments except the one held, and only their bytes come off the total', async () => {
    await product('it-tm-hold');
    await ticket('it-tm-hold', 'it-tm-h1', 'closed', 1000, 1000);
    await attachment('it-tm-hold', 'it-tm-hx1', 'it-tm-h1', 'stored', 100);
    await attachment('it-tm-hold', 'it-tm-hx2', 'it-tm-h1', 'stored', 50);
    await hold('it-tm-hh1', 'it-tm-h1', 'it-tm-hx1');
    await db
      .prepare(`INSERT INTO counters (key, value) VALUES (?, 150) ON CONFLICT (key) DO UPDATE SET value = value + 150`)
      .bind(STORED_BYTES)
      .run();
    const before = await storedBytes(db);
    const { deleted, files } = recorder();
    await deleteAttachments(db, files, 'it-tm-h1', NOW);
    expect.soft(deleted.flat().sort()).toEqual(['k-it-tm-hx2', 'th-it-tm-hx2']);
    expect.soft(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-hx1')).toEqual({ state: 'stored' });
    expect.soft(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-hx2')).toEqual({ state: 'deleted' });
    expect.soft(await storedBytes(db)).toBe(before - 50);
  });

  it('deletes none of a closed ticket’s attachments while the whole ticket is held', async () => {
    await product('it-tm-holdt');
    await ticket('it-tm-holdt', 'it-tm-h2', 'closed', 1000, 1000);
    await attachment('it-tm-holdt', 'it-tm-hx3', 'it-tm-h2', 'stored', 10);
    await hold('it-tm-hh2', 'it-tm-h2', null);
    const { deleted, files } = recorder();
    await deleteAttachments(db, files, 'it-tm-h2', NOW);
    expect.soft(deleted).toEqual([]);
    expect.soft(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-hx3')).toEqual({ state: 'stored' });
  });

  it('deletes an attachment whose hold was lifted', async () => {
    await product('it-tm-holdl');
    await ticket('it-tm-holdl', 'it-tm-h3', 'closed', 1000, 1000);
    await attachment('it-tm-holdl', 'it-tm-hx4', 'it-tm-h3', 'stored', 10);
    await hold('it-tm-hh3', 'it-tm-h3', 'it-tm-hx4', 2000);
    const { deleted, files } = recorder();
    await deleteAttachments(db, files, 'it-tm-h3', NOW);
    expect.soft(deleted.flat().sort()).toEqual(['k-it-tm-hx4', 'th-it-tm-hx4']);
    expect.soft(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-hx4')).toEqual({ state: 'deleted' });
  });

  it('deletes none of a closed ticket’s text while any hold on it is active, one attachment’s included', async () => {
    await product('it-tm-holdx');
    await ticket('it-tm-holdx', 'it-tm-h4', 'closed', 1000, 1000);
    await db
      .prepare(`INSERT INTO messages (id, ticket_id, author, body, created_at) VALUES ('it-tm-hm1', 'it-tm-h4', 'customer', 'Hello', 1000)`)
      .run();
    await attachment('it-tm-holdx', 'it-tm-hx5', 'it-tm-h4', 'stored', 10);
    await attachment('it-tm-holdx', 'it-tm-hx6', 'it-tm-h4', 'deleted', 10);
    await staffRead('it-tm-rep-h@example.com', 'it-tm-h4');
    await hold('it-tm-hh4', 'it-tm-h4', 'it-tm-hx5');
    await deleteText(db, recorder().files, 'it-tm-h4', NOW);
    expect.soft(await one('SELECT status FROM tickets WHERE id = ?', 'it-tm-h4')).toEqual({ status: 'closed' });
    expect.soft(await one('SELECT body FROM messages WHERE id = ?', 'it-tm-hm1')).toEqual({ body: 'Hello' });
    expect.soft(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-hx5')).toEqual({ state: 'stored' });
    expect.soft(await one('SELECT state FROM attachments WHERE id = ?', 'it-tm-hx6')).toEqual({ state: 'deleted' });
    expect.soft(await one('SELECT read_seq FROM reads WHERE ticket_id = ?', 'it-tm-h4')).toEqual({ read_seq: 1 });
  });
});

describe('overdue on D1', () => {
  it('lists exactly what is past its due date, and nothing not yet due', async () => {
    await product('it-tm-due', 30, 365);
    // Closed 31 days ago: attachments past due, text not.
    await ticket('it-tm-due', 'it-tm-d1', 'closed', NOW - 31 * DAY_MS, NOW - 31 * DAY_MS);
    await attachment('it-tm-due', 'it-tm-d1-a', 'it-tm-d1', 'stored', 1);
    // Closed 29 days ago: nothing due yet.
    await ticket('it-tm-due', 'it-tm-d2', 'closed', NOW - 29 * DAY_MS, NOW - 29 * DAY_MS);
    await attachment('it-tm-due', 'it-tm-d2-a', 'it-tm-d2', 'stored', 1);
    // Closed 366 days ago: text past due.
    await ticket('it-tm-due', 'it-tm-d3', 'closed', NOW - 366 * DAY_MS, NOW - 366 * DAY_MS);
    // Waiting 8 days: auto-close past due; waiting 6 days: not.
    await ticket('it-tm-due', 'it-tm-d4', 'waiting', NOW - 8 * DAY_MS, null);
    await ticket('it-tm-due', 'it-tm-d5', 'waiting', NOW - 6 * DAY_MS, null);
    // An upload pending 2 hours: past due; 30 minutes: not.
    await attachment('it-tm-due', 'it-tm-u1', null, 'pending', 1, NOW - 2 * 3_600_000);
    await attachment('it-tm-due', 'it-tm-u2', null, 'pending', 1, NOW - 1_800_000);
    await attachment('it-tm-due', 'it-tm-o1', null, 'stored', 1, NOW - 2 * DAY_MS);
    await attachment('it-tm-due', 'it-tm-o2', null, 'stored', 1, NOW - 3_600_000);

    const mine = (await overdue(db, NOW)).filter((o) => o.productId === 'it-tm-due');
    expect(mine).toHaveLength(5);
    expect(mine).toEqual(
      expect.arrayContaining([
        { kind: 'text', id: 'it-tm-d3', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
        { kind: 'autoclose', id: 'it-tm-d4', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
        { kind: 'attachment', id: 'it-tm-d1-a', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
        { kind: 'unattached', id: 'it-tm-o1', productId: 'it-tm-due', dueAt: NOW - DAY_MS },
      ]),
    );
    // Oldest due first: the upload, due an hour ago, comes last.
    expect(mine.at(-1)).toEqual({ kind: 'upload', id: 'it-tm-u1', productId: 'it-tm-due', dueAt: NOW - 3_600_000 });
  });
});
