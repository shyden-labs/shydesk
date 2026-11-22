import { describe, expect, it } from 'vitest';
import { ticketPageFor } from '../../src/tickets/test-site.ts';

// shyden-labs/shydesk#263: a TEST site's ticket opens on that site's own copy of the ticket page.
describe('ticketPageFor', () => {
  it('keeps the live ticket page for a live ticket', () => {
    expect(ticketPageFor('https://shytalk.app/support/ticket', null)).toBe('https://shytalk.app/support/ticket');
  });

  it("moves the page's path and query onto the TEST site", () => {
    expect(ticketPageFor('https://shytalk.app/support/ticket?lang=id', 'https://test.shytalk.app')).toBe(
      'https://test.shytalk.app/support/ticket?lang=id',
    );
  });
});
