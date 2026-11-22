import { describe, it, expect } from 'vitest';
import { isTestTicket, TEST_TICKET_CLEAR_MS } from '../../src/tickets/test-tickets.ts';

// shyden-labs/shydesk#254: on dev, the test requests shyden.co.uk's dev journey sends
// (`support-test+<engine>-<time>@shyden.co.uk`) are cleared by themselves. Only a
// ticket from the named product AND an address matching the pattern counts.

const DEV = { TEST_TICKET_PRODUCT: 'shyden-co-uk', TEST_TICKET_EMAIL: 'support-test+*@shyden.co.uk' };

describe('isTestTicket', () => {
  it('matches the named product with a plus-address the pattern names', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'support-test+chromium-1763769600@shyden.co.uk')).toBe(true);
  });

  it('leaves any other address of that product alone', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'ana@example.com')).toBe(false);
  });

  it('leaves the same matching address alone on another product', () => {
    expect(isTestTicket(DEV, 'shytalk', 'support-test+chromium-1@shyden.co.uk')).toBe(false);
  });

  it('needs something after the plus', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'support-test+@shyden.co.uk')).toBe(false);
  });

  it('does not match the bare address without a plus part', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'support-test@shyden.co.uk')).toBe(false);
  });

  it('does not match a longer local part ending the same way', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'xsupport-test+a@shyden.co.uk')).toBe(false);
  });

  it('does not match another domain that starts with the same name', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'support-test+a@shyden.co.uk.example.com')).toBe(false);
  });

  it('does not let the wildcard cross the @', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'support-test+a@example.com@shyden.co.uk')).toBe(false);
  });

  it('treats the dots in the pattern as dots, not any character', () => {
    expect(isTestTicket(DEV, 'shyden-co-uk', 'support-test+a@shydenXcoXuk')).toBe(false);
  });

  it('matches nothing when no setting is given, as on live', () => {
    expect(isTestTicket({}, 'shyden-co-uk', 'support-test+a@shyden.co.uk')).toBe(false);
  });

  it('matches nothing when only the product is set', () => {
    expect(isTestTicket({ TEST_TICKET_PRODUCT: 'shyden-co-uk' }, 'shyden-co-uk', 'support-test+a@shyden.co.uk')).toBe(false);
  });

  it('matches nothing when only the address is set', () => {
    expect(isTestTicket({ TEST_TICKET_EMAIL: DEV.TEST_TICKET_EMAIL }, 'shyden-co-uk', 'support-test+a@shyden.co.uk')).toBe(false);
  });

  it('clears an hour after creation, long enough for the journey to read its thread', () => {
    expect(TEST_TICKET_CLEAR_MS).toBe(3_600_000);
  });
});
