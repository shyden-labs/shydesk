import { DAY_MS } from '../tickets/status.ts';

/** Why evidence is held (migrations/0004_release_2.sql, `legal_holds.reason`). */
export type HoldReason = 'crime_unreported' | 'reported' | 'preservation';

/** The fields of a `legal_holds` row that decide when it may first be lifted. */
export interface HoldTiming {
  reason: HoldReason;
  placed_at: number;
  /** The report date (`reported`) or the request date (`preservation`); null for `crime_unreported`. */
  basis_at: number | null;
  renewals: number;
  order_pending: number;
  no_report_reason: string | null;
}

/** Days a hold reported to the authorities is kept from the report (spec, pending the lawyer check). */
export const REPORTED_KEEP_DAYS = 365;
/** Days a preservation request is kept from the request, and again for each renewal (spec, pending the lawyer check). */
export const PRESERVATION_KEEP_DAYS = 90;

/**
 * When a hold may first be lifted, in ms; null while it cannot be lifted at all
 * (shyden-labs/shydesk#62): a possible crime not yet reported nor recorded as
 * needing no report, a production order unanswered, or no basis date.
 */
export function earliestRelease(h: HoldTiming): number | null {
  if (h.reason === 'crime_unreported') return h.no_report_reason === null ? null : h.placed_at;
  if (h.basis_at === null) return null;
  if (h.reason === 'reported') return h.basis_at + REPORTED_KEEP_DAYS * DAY_MS;
  if (h.order_pending === 1) return null;
  return h.basis_at + PRESERVATION_KEEP_DAYS * DAY_MS * (1 + h.renewals);
}
