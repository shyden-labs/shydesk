/**
 * Real input for the Playwright suite (shyden-labs/shydesk#176): trusted clicks, key presses
 * and file choices, each found by the accessible name a person would read.
 */
import type { Locator, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { typedMismatch, type Fixture } from '../../e2e/harness/targets.ts';

const MEDIA = resolve(import.meta.dirname, '../../fixtures/media');

/**
 * The one element named `label`: by its label, or a button or link of that name. One locator,
 * so every action on it waits for the page to draw it; Playwright's strict mode fails the
 * action if the name matches more than one element.
 */
export function named(page: Page, label: string): Locator {
  return page
    .getByLabel(label, { exact: true })
    .or(page.getByRole('button', { name: label, exact: true }))
    .or(page.getByRole('link', { name: label, exact: true }));
}

/** A real click on the element named `label`. */
export async function tap(page: Page, label: string): Promise<void> {
  await named(page, label).click();
}

/** Real key presses into the field named `label`, after a real click on it. */
export async function type(page: Page, label: string, text: string): Promise<void> {
  const field = named(page, label);
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
