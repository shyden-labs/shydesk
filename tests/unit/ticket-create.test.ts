import { describe, expect, it } from 'vitest';
import { AttachmentError, createTicket, newToken, ticketLink, type NewTicket } from '../../src/tickets/create.ts';
import { openToken } from '../../src/tickets/seal.ts';
import { hashKey } from '../../src/products.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// A new ticket from the contact form (shyden-labs/shydesk#19). The customer's
// private token is returned once; only its SHA-256 is stored. The ticket, its
// first message and its attachments are written in one batch, and only
// attachments this product finished uploading and no ticket has yet are taken.
const NOW = 1_800_000_000_000;
const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const input = (over: Partial<NewTicket> = {}): NewTicket => ({
  productId: 'shytalk',
  typeId: 'shytalk:support',
  email: 'Ana@Example.com',
  subject: 'Cannot sign in',
  category: 'account',
  message: 'The code never arrives.',
  fields: { Device: 'Pixel 9' },
  attachmentIds: [],
  now: NOW,
  tokenKey: TOKEN_KEY,
  ...over,
});

const usable =
  (ids: string[]): Answer =>
  (sql) =>
    sql.includes('FROM attachments') ? ids.map((id) => ({ id })) : [];

describe('newToken', () => {
  it('is 43 base64url characters', () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is new each time', () => {
    expect(newToken()).not.toBe(newToken());
  });
});

describe('ticketLink', () => {
  it('is the product ticket page with the token after #t=', () => {
    expect(ticketLink('https://shytalk.app/support/ticket', 'abc')).toBe('https://shytalk.app/support/ticket#t=abc');
  });
});

describe('createTicket', () => {
  it('returns a 43-character token and stores only its hash', async () => {
    const { db, statements } = standInDb();
    const { token } = await createTicket(db, input());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const insert = statements.find((s) => s.sql.includes('INSERT INTO tickets'));
    expect(insert?.values).toContain(await hashKey(token));
    expect(statements.flatMap((s) => s.values)).not.toContain(token);
  });

  it('stores a sealed copy of the token that opens with the key', async () => {
    const { db, statements } = standInDb();
    const { token } = await createTicket(db, input());
    const insert = statements.find((s) => s.sql.includes('INSERT INTO tickets'));
    expect(insert?.sql).toContain('token_sealed');
    const opened = await Promise.all(
      (insert?.values ?? []).filter((v): v is string => typeof v === 'string').map((v) => openToken(TOKEN_KEY, v).catch(() => null)),
    );
    expect(opened).toContain(token);
  });

  it('writes the ticket open, on the next feed seq, with the email lower-cased', async () => {
    const { db, statements } = standInDb();
    const { id } = await createTicket(db, input());
    const batch = statements.filter((s) => s.method === 'batch');
    expect(batch[0]?.sql).toMatch(/INSERT INTO counters[\s\S]*feed_seq/);
    const insert = batch[1];
    expect(insert?.sql).toMatch(/INSERT INTO tickets[\s\S]*'open'[\s\S]*SELECT value FROM counters WHERE key = 'feed_seq'/);
    expect(insert?.values).toEqual([
      id,
      'shytalk',
      'shytalk:support',
      'ana@example.com',
      'Cannot sign in',
      'account',
      JSON.stringify({ Device: 'Pixel 9' }),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.any(String),
      NOW,
      NOW,
    ]);
  });

  it('writes the message as the customer first message on the ticket', async () => {
    const { db, statements } = standInDb();
    const { id } = await createTicket(db, input());
    const message = statements.find((s) => s.sql.includes('INSERT INTO messages'));
    expect(message?.method).toBe('batch');
    expect(message?.values).toEqual([expect.any(String), id, 'The code never arrives.', NOW]);
    expect(message?.sql).toContain("'customer'");
  });

  it('takes stored attachments of this product that no ticket has, onto the ticket and its first message', async () => {
    const { db, statements } = standInDb(usable(['a1', 'a2']));
    const { id } = await createTicket(db, input({ attachmentIds: ['a1', 'a2'] }));
    const check = statements.find((s) => s.method !== 'batch' && s.sql.includes('FROM attachments'));
    expect(check?.sql).toMatch(/product_id = \?[\s\S]*state = 'stored'[\s\S]*ticket_id IS NULL/);
    expect(check?.values).toEqual(['a1', 'a2', 'shytalk']);
    const take = statements.find((s) => s.sql.startsWith('UPDATE attachments'));
    const messageId = statements.find((s) => s.sql.includes('INSERT INTO messages'))?.values[0];
    expect(take?.method).toBe('batch');
    expect(take?.sql).toMatch(/product_id = \?[\s\S]*state = 'stored'[\s\S]*ticket_id IS NULL/);
    expect(take?.values).toEqual([id, messageId, 'a1', 'a2', 'shytalk']);
  });

  it('refuses an attachment that is another product, still pending or on another ticket, writing nothing', async () => {
    const { db, statements } = standInDb(usable(['a1']));
    await expect(createTicket(db, input({ attachmentIds: ['a1', 'theirs'] }))).rejects.toThrow(
      new AttachmentError('An attachment could not be found. Upload it again.'),
    );
    expect(statements.filter((s) => s.method === 'batch')).toHaveLength(0);
  });

  it('counts a repeated attachment id once', async () => {
    const { db, statements } = standInDb(usable(['a1']));
    await createTicket(db, input({ attachmentIds: ['a1', 'a1'] }));
    expect(statements.find((s) => s.sql.startsWith('UPDATE attachments'))?.values).toEqual([
      expect.any(String),
      expect.any(String),
      'a1',
      'shytalk',
    ]);
  });

  it('asks nothing about attachments when there are none', async () => {
    const { db, statements } = standInDb();
    await createTicket(db, input());
    expect(statements.some((s) => s.sql.includes('attachments'))).toBe(false);
  });
});
