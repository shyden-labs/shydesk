/**
 * Reading the page for the Playwright suite (shyden-labs/shydesk#176): text found by the
 * accessible name a person would read, and the touch size of controls.
 */
import type { Page } from '@playwright/test';

/** The text of the element named `label` once it holds `expected`, or a failure showing what it held. */
export function textHolding(page: Page, label: string, expected: string): Promise<string> {
  return Promise.reject(new Error(`not ported: "${label}" holding "${expected}" on ${page.url()}`));
}

/** Fails unless each control named in `labels` is drawn at least 44 × 44 px (shyden-labs/shydesk#256). */
export function touchSized(page: Page, labels: readonly string[]): Promise<void> {
  return Promise.reject(new Error(`not ported: ${labels.join(', ')} on ${page.url()}`));
}
