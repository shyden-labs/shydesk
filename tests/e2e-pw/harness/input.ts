/**
 * Real input for the Playwright suite (shyden-labs/shydesk#176): trusted clicks, key presses
 * and file choices, each found by the accessible name a person would read.
 */
import type { Locator, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { typedMismatch, type Fixture } from '../../e2e/harness/targets.ts';

const MEDIA = resolve(import.meta.dirname, '../../fixtures/media');

/**
 * The one element named `label`: by its label first, else a button or link of that name.
 * Playwright's strict mode fails the action if the name matches more than one element.
 */
async function named(page: Page, label: string): Promise<Locator> {
  const byLabel = page.getByLabel(label, { exact: true });
  if ((await byLabel.count()) > 0) return byLabel;
  return page.getByRole('button', { name: label, exact: true }).or(page.getByRole('link', { name: label, exact: true }));
}

/** A real click on the element named `label`. */
export async function tap(page: Page, label: string): Promise<void> {
  await (await named(page, label)).click();
}

/** Real key presses into the field named `label`, after a real click on it. */
export async function type(page: Page, label: string, text: string): Promise<void> {
  const field = await named(page, label);
  const before = await field.inputValue();
  await field.click();
  await field.pressSequentially(text);
  const mismatch = typedMismatch(label, before + text, await field.inputValue());
  if (mismatch !== undefined) throw new Error(mismatch);
}

/** One test file chosen through the file input named `label`, by the browser's own file chooser. */
export async function pickFile(page: Page, label: string, fixture: Fixture): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tap(page, label)]);
  await chooser.setFiles(resolve(MEDIA, fixture));
}
