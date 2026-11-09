import { describe, it, expect } from 'vitest';
import { validateProduct, type ProductInput } from '../../src/products.ts';

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
  privacyPolicyUrlEn: 'https://shytalk.app/privacy',
  privacyPolicyUrlId: 'https://shytalk.app/id/privacy',
};

const errorsFor = (change: Partial<ProductInput>): string[] => validateProduct({ ...GOOD, ...change });

describe('validateProduct', () => {
  it('accepts a well-formed product', () => {
    expect(validateProduct(GOOD)).toEqual([]);
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

  // shyden-labs/shydesk#78 AC1: every product links its English and Indonesian privacy policies.
  it.each([
    ['privacyPolicyUrlEn', 'English privacy policy URL must be an https address.'],
    ['privacyPolicyUrlId', 'Indonesian privacy policy URL must be an https address.'],
  ] as const)('refuses a missing or non-https %s', (field, message) => {
    expect(errorsFor({ [field]: '' })).toEqual([message]);
    expect(errorsFor({ [field]: 'http://shytalk.app/privacy' })).toEqual([message]);
    expect(errorsFor({ [field]: 'not a url' })).toEqual([message]);
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
