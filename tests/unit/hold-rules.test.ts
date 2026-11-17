import { describe, it, expect } from 'vitest';
import { earliestRelease, type HoldTiming } from '../../src/holds/rules.ts';
import { DAY_MS } from '../../src/tickets/status.ts';

// When a legal hold may first be lifted (shyden-labs/shydesk#62 AC2; plan
// docs/superpowers/plans/2026-11-07-shydesk-release-2.md, Task 6): reported to
// the authorities, 365 days from the report; a preservation request, 90 days
// from the request plus 90 for each renewal, and never while a production
// order is unanswered; a possible crime not yet reported, never until the
// admin records why no report is needed. Null means it cannot be lifted yet.

const PLACED = Date.UTC(2026, 10, 1, 9);
const BASIS = Date.UTC(2026, 9, 20, 15);

function hold(fields: Partial<HoldTiming>): HoldTiming {
  return {
    reason: 'reported',
    placed_at: PLACED,
    basis_at: BASIS,
    renewals: 0,
    order_pending: 0,
    no_report_reason: null,
    ...fields,
  };
}

describe('earliestRelease', () => {
  it('a hold reported to the authorities is kept 365 days from the report', () => {
    expect(earliestRelease(hold({ reason: 'reported' }))).toBe(BASIS + 365 * DAY_MS);
  });

  it('a preservation request is kept 90 days from the request', () => {
    expect(earliestRelease(hold({ reason: 'preservation' }))).toBe(BASIS + 90 * DAY_MS);
  });

  it('a preservation request renewed twice is kept 270 days from the request', () => {
    expect(earliestRelease(hold({ reason: 'preservation', renewals: 2 }))).toBe(BASIS + 270 * DAY_MS);
  });

  it('a preservation request with a production order unanswered cannot be lifted', () => {
    expect(earliestRelease(hold({ reason: 'preservation', renewals: 2, order_pending: 1 }))).toBeNull();
  });

  it('a possible crime not yet reported cannot be lifted', () => {
    expect(earliestRelease(hold({ reason: 'crime_unreported', basis_at: null }))).toBeNull();
  });

  it('a possible crime the admin recorded needs no report may be lifted from when it was placed', () => {
    const recorded = hold({ reason: 'crime_unreported', basis_at: null, no_report_reason: 'Not a crime: a misunderstanding.' });
    expect(earliestRelease(recorded)).toBe(PLACED);
  });

  it('a reported or preservation hold with no basis date cannot be lifted', () => {
    expect(earliestRelease(hold({ reason: 'reported', basis_at: null }))).toBeNull();
    expect(earliestRelease(hold({ reason: 'preservation', basis_at: null }))).toBeNull();
  });
});
