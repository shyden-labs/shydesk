/**
 * Real input for the Playwright suite (shyden-labs/shydesk#176): trusted clicks, key presses
 * and file choices, each found by the accessible name a person would read.
 */
import type { Page } from '@playwright/test';
import type { Fixture } from '../../e2e/harness/targets.ts';

/** A real click on the element named `label`. */
export function tap(page: Page, label: string): Promise<void> {
  return Promise.reject(new Error(`not ported: tap "${label}" on ${page.url()}`));
}

/** Real key presses into the field named `label`, after a real click on it. */
export function type(page: Page, label: string, text: string): Promise<void> {
  return Promise.reject(new Error(`not ported: type "${text}" into "${label}" on ${page.url()}`));
}

/** One test file chosen through the file input named `label`, by the browser's own file chooser. */
export function pickFile(page: Page, label: string, fixture: Fixture): Promise<void> {
  return Promise.reject(new Error(`not ported: pickFile ${fixture} into "${label}" on ${page.url()}`));
}
