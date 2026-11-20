import { describe, it, expect } from 'vitest';
import { validateCallback, validatePunishments, validateProduct, type ProductInput } from '../../src/products.ts';

/**
 * Admin settings validation (shyden-labs/shydesk#17 AC1; plan Task 4 step 1).
 * Each rule has its own test so a broken rule names itself.
 */

const GOOD: ProductInput = {
  id: 'shytalk',
  name: 'ShyTalk',
  senderAddress: 'no-reply@shytalk.app',
  ticketPageUrl: 'https://shytalk.app/support/ticket',
  allowedOrigins: ['https://shytalk.app', 'https://dev.shytalk.app:8443'],
  monthlyEmailShare: 500,
  attachmentsKeepDays: 30,
  textKeepDays: 365,
};

const errorsFor = (change: Partial<ProductInput>): string[] => validateProduct({ ...GOOD, ...change });

describe('validateProduct', () => {
  it('accepts a well-formed product', () => {
    expect(validateProduct(GOOD)).toEqual([]);
  });

  it('answers a 50,000-character hostile sender address within 50 ms (shyden-labs/shydesk#184)', () => {
    const started = performance.now();
    expect(errorsFor({ senderAddress: 'a@' + '.'.repeat(50_000) + '@' })).toEqual([
      'Sender address must be an email address ending in a domain.',
    ]);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('accepts a product id of exactly 2 and exactly 40 characters', () => {
    expect(errorsFor({ id: 'ab' })).toEqual([]);
    expect(errorsFor({ id: 'a'.repeat(40) })).toEqual([]);
  });

  it('refuses a product id of 1 character', () => {
    expect(errorsFor({ id: 'a' })).toEqual(['Product id must be 2 to 40 lowercase letters, digits or hyphens.']);
  });

  it('refuses a product id of 41 characters', () => {
    expect(errorsFor({ id: 'a'.repeat(41) })).toHaveLength(1);
  });

  it('refuses a product id with capitals', () => {
    expect(errorsFor({ id: 'ShyTalk' })).toHaveLength(1);
  });

  it('refuses a product id with an underscore or space', () => {
    expect(errorsFor({ id: 'shy_talk' })).toHaveLength(1);
    expect(errorsFor({ id: 'shy talk' })).toHaveLength(1);
  });

  it('refuses a product id with a trailing newline', () => {
    expect(errorsFor({ id: 'shytalk\n' })).toHaveLength(1);
  });

  it('refuses an empty name', () => {
    expect(errorsFor({ name: '   ' })).toEqual(['Name is required.']);
  });

  it('refuses a sender address with no domain', () => {
    expect(errorsFor({ senderAddress: 'no-reply' })).toEqual(['Sender address must be an email address ending in a domain.']);
    expect(errorsFor({ senderAddress: 'no-reply@' })).toHaveLength(1);
    expect(errorsFor({ senderAddress: 'no-reply@localhost' })).toHaveLength(1);
    expect(errorsFor({ senderAddress: '@shytalk.app' })).toHaveLength(1);
  });

  it('refuses a sender address with spaces or two @ signs', () => {
    expect(errorsFor({ senderAddress: 'no reply@shytalk.app' })).toHaveLength(1);
    expect(errorsFor({ senderAddress: 'a@b@shytalk.app' })).toHaveLength(1);
  });

  it('refuses a ticket page URL that is not https', () => {
    expect(errorsFor({ ticketPageUrl: 'http://shytalk.app/support/ticket' })).toEqual([
      'Ticket page URL must be an https address with no #fragment.',
    ]);
  });

  it('refuses a ticket page URL with a fragment', () => {
    expect(errorsFor({ ticketPageUrl: 'https://shytalk.app/support#ticket' })).toHaveLength(1);
  });

  it('refuses a ticket page URL that does not parse', () => {
    expect(errorsFor({ ticketPageUrl: 'not a url' })).toHaveLength(1);
  });

  it('refuses a ticket page URL whose origin is not an allowed origin', () => {
    expect(errorsFor({ ticketPageUrl: 'https://other.example/ticket' })).toEqual([
      "The ticket page URL's origin must be one of the allowed origins.",
    ]);
  });

  it('refuses no allowed origins', () => {
    expect(errorsFor({ allowedOrigins: [] })).toContain('At least one allowed origin is required.');
  });

  it.each([
    ['a path', 'https://shytalk.app/support'],
    ['a trailing slash', 'https://shytalk.app/'],
    ['a wildcard', 'https://*.shytalk.app'],
    ['http', 'http://shytalk.app'],
    ['a query', 'https://shytalk.app?x=1'],
    ['a user', 'https://me@shytalk.app'],
    ['capitals', 'https://ShyTalk.app'],
    ['the default port written out', 'https://shytalk.app:443'],
    ['nonsense', 'shytalk'],
  ])('refuses an allowed origin with %s', (_, origin) => {
    expect(errorsFor({ allowedOrigins: ['https://shytalk.app', origin] })).toEqual([
      `Allowed origin "${origin}" must be exactly https://host or https://host:port.`,
    ]);
  });

  it('accepts a monthly email share of 0', () => {
    expect(errorsFor({ monthlyEmailShare: 0 })).toEqual([]);
  });

  it('refuses a negative or fractional monthly email share', () => {
    expect(errorsFor({ monthlyEmailShare: -1 })).toEqual(['Monthly email share must be a whole number of 0 or more.']);
    expect(errorsFor({ monthlyEmailShare: 1.5 })).toHaveLength(1);
    expect(errorsFor({ monthlyEmailShare: Number.NaN })).toHaveLength(1);
  });

  it('accepts keep-days of 1', () => {
    expect(errorsFor({ attachmentsKeepDays: 1, textKeepDays: 1 })).toEqual([]);
  });

  it('refuses attachment keep-days below 1', () => {
    expect(errorsFor({ attachmentsKeepDays: 0 })).toEqual(['Attachment keep-days must be a whole number of 1 or more.']);
  });

  it('refuses text keep-days below 1 or fractional', () => {
    expect(errorsFor({ textKeepDays: 0 })).toEqual(['Text keep-days must be a whole number of 1 or more.']);
    expect(errorsFor({ textKeepDays: 2.5 })).toHaveLength(1);
  });
});

/**
 * Release 2 product settings (shyden-labs/shydesk#58 AC1, AC2; Release 2 plan Task 2 step 1).
 */
describe('validatePunishments', () => {
  const BAN = { key: 'ban-7d', label: 'Ban 7 days', duration_seconds: 604800 };
  const REMOVE = { key: 'remove-room', label: 'Remove room', duration_seconds: null };

  it('accepts a timed punishment and one with no end', () => {
    expect(validatePunishments([BAN, REMOVE])).toEqual([]);
  });

  it('accepts an empty list', () => {
    expect(validatePunishments([])).toEqual([]);
  });

  it('refuses a key used twice', () => {
    expect(validatePunishments([BAN, { ...REMOVE, key: 'ban-7d' }])).toEqual(['Punishment key "ban-7d" is used more than once.']);
  });

  it('refuses "Ban 7 days" as a key', () => {
    expect(validatePunishments([{ ...BAN, key: 'Ban 7 days' }])).toEqual([
      'Punishment key "Ban 7 days" must be 1 to 32 lowercase letters, digits or hyphens.',
    ]);
  });

  it('accepts a key of exactly 32 characters and refuses 33 or none', () => {
    expect(validatePunishments([{ ...BAN, key: 'a'.repeat(32) }])).toEqual([]);
    expect(validatePunishments([{ ...BAN, key: 'a'.repeat(33) }])).toHaveLength(1);
    expect(validatePunishments([{ ...BAN, key: '' }])).toHaveLength(1);
  });

  it('accepts a label of exactly 60 characters and refuses 61', () => {
    expect(validatePunishments([{ ...BAN, label: 'x'.repeat(60) }])).toEqual([]);
    expect(validatePunishments([{ ...BAN, label: 'x'.repeat(61) }])).toEqual(['Punishment "ban-7d" needs a label of 1 to 60 characters.']);
  });

  it('refuses a blank label', () => {
    expect(validatePunishments([{ ...BAN, label: '   ' }])).toEqual(['Punishment "ban-7d" needs a label of 1 to 60 characters.']);
  });

  it('accepts a duration of exactly 60 seconds and exactly one year', () => {
    expect(validatePunishments([{ ...BAN, duration_seconds: 60 }])).toEqual([]);
    expect(validatePunishments([{ ...BAN, duration_seconds: 31_536_000 }])).toEqual([]);
  });

  it('refuses a duration of 59 seconds', () => {
    expect(validatePunishments([{ ...BAN, duration_seconds: 59 }])).toEqual([
      'Punishment "ban-7d" must last 60 to 31536000 seconds (one year), or be left blank for no end.',
    ]);
  });

  it('refuses a duration of one year and a second, a fraction, and not a number', () => {
    expect(validatePunishments([{ ...BAN, duration_seconds: 31_536_001 }])).toHaveLength(1);
    expect(validatePunishments([{ ...BAN, duration_seconds: 60.5 }])).toHaveLength(1);
    expect(validatePunishments([{ ...BAN, duration_seconds: Number.NaN }])).toHaveLength(1);
  });

  it('names every broken rule, in list order', () => {
    expect(validatePunishments([{ key: 'Bad', label: '', duration_seconds: 1 }])).toEqual([
      'Punishment key "Bad" must be 1 to 32 lowercase letters, digits or hyphens.',
      'Punishment "Bad" needs a label of 1 to 60 characters.',
      'Punishment "Bad" must last 60 to 31536000 seconds (one year), or be left blank for no end.',
    ]);
  });
});

describe('validateCallback', () => {
  const CALLBACK = 'https://api.shytalk.app/shydesk/punish';
  const APPEAL = 'https://shytalk.app/appeal';

  it('accepts https addresses', () => {
    expect(validateCallback(CALLBACK, APPEAL)).toEqual([]);
  });

  it('refuses http://shytalk.app/x as the callback', () => {
    expect(validateCallback('http://shytalk.app/x', APPEAL)).toEqual([
      'Callback URL must be an https address with no user name, password or #fragment.',
    ]);
  });

  it('refuses https://u:p@shytalk.app/x as the callback', () => {
    expect(validateCallback('https://u:p@shytalk.app/x', APPEAL)).toHaveLength(1);
  });

  it('refuses a callback with a user name and no password', () => {
    expect(validateCallback('https://u@shytalk.app/x', APPEAL)).toHaveLength(1);
  });

  it('refuses an appeal page over http, with credentials, or with a #fragment', () => {
    const error = 'Appeal page URL must be an https address with no user name, password or #fragment.';
    expect(validateCallback(CALLBACK, 'http://shytalk.app/appeal')).toEqual([error]);
    expect(validateCallback(CALLBACK, 'https://u:p@shytalk.app/appeal')).toEqual([error]);
    expect(validateCallback(CALLBACK, 'https://shytalk.app/appeal#x')).toEqual([error]);
  });

  it('refuses text that is not an address, for both', () => {
    expect(validateCallback('not a url', '')).toHaveLength(2);
  });
});
