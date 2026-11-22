import { describe, expect, it } from 'vitest';
import { ticketPageFor } from '../../src/tickets/test-site.ts';

// shyden-labs/shydesk#263: a TEST site's ticket opens on that site's own copy of the ticket page.
const SHYTALK = { ticketPageUrl: 'https://shytalk.app/support/ticket?lang=id', testOrigins: ['https://test.shytalk.app'] };

describe('ticketPageFor', () => {
  it('keeps the live ticket page for a live ticket', () => {
    expect(ticketPageFor(SHYTALK, null)).toBe('https://shytalk.app/support/ticket?lang=id');
  });

  it("moves the page's path and query onto the TEST site", () => {
    expect(ticketPageFor(SHYTALK, 'https://test.shytalk.app')).toBe('https://test.shytalk.app/support/ticket?lang=id');
  });

  // A TEST site taken off the product may be someone else's now: its tickets' links go to the live page.
  it('keeps the live ticket page for a TEST site the product no longer lists', () => {
    expect(ticketPageFor({ ...SHYTALK, testOrigins: [] }, 'https://test.shytalk.app')).toBe('https://shytalk.app/support/ticket?lang=id');
  });
});
