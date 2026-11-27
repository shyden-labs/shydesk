/**
 * Real input for the Playwright suite (shyden-labs/shydesk#176): trusted clicks, key presses
 * and file choices, each found by the accessible name a person would read.
 */
import type { Locator, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { typedMismatch, type Fixture } from '../../e2e/harness/targets.ts';

const MEDIA = resolve(import.meta.dirname, '../../fixtures/media');

/** A name a select is known by: its label's words, then the chosen option's, as a `<label>` wrapping it gives. */
function selectNamed(label: string): RegExp {
  // No space is required after the label's words: a label's text and its select's option may join without one.
  // A second select whose name starts the same way fails Playwright's strict mode, never matches quietly.
  return new RegExp(`^${label.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}`);
}

/**
 * The one element named `label`: by its label, a select whose label starts with it (a `<label>`
 * wrapping a select adds the chosen option to its name), or a button or link of that name. One
 * locator, so every action on it waits for the page to draw it; Playwright's strict mode fails
 * the action if the name matches more than one element.
 */
export function named(page: Page, label: string): Locator {
  return page
    .getByLabel(label, { exact: true })
    .or(page.getByRole('combobox', { name: selectNamed(label) }))
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
  // DIAGNOSTIC (shyden-labs/shydesk#176), removed before merge: what a click that opens no chooser reached.
  const browser = page.context().browser()?.browserType().name() ?? 'unknown';
  await page.evaluate(() => {
    const w = window as unknown as { pick176?: string[]; pick176On?: boolean };
    w.pick176 = [];
    if (w.pick176On === true) return;
    w.pick176On = true;
    const t0 = performance.now();
    for (const kind of ['pointerdown', 'mousedown', 'mouseup', 'click', 'cancel', 'input', 'change', 'focus', 'blur']) {
      window.addEventListener(
        kind,
        (e) => {
          const el = e.composedPath()[0];
          const name = el instanceof Element ? `${el.tagName}[${el.getAttribute('type') ?? ''}]` : (el?.constructor.name ?? 'none');
          w.pick176?.push(`${String(Math.round(performance.now() - t0))}ms ${kind} trusted=${String(e.isTrusted)} ${name}`);
        },
        true,
      );
    }
  });
  const started = Date.now();
  const chooserP = page.waitForEvent('filechooser', { timeout: 20_000 });
  await tap(page, label);
  const chooser = await chooserP.catch(async (error: unknown) => {
    const state = await page.evaluate(() => {
      const w = window as unknown as { pick176?: string[] };
      const inputs = Array.from(document.querySelectorAll('input[type=file]')).map((i) => {
        const input = i as HTMLInputElement;
        return `connected=${String(input.isConnected)} disabled=${String(input.disabled)} files=${String(input.files?.length ?? -1)}`;
      });
      return `events=[${(w.pick176 ?? []).join(' | ')}] inputs=[${inputs.join(' ; ')}] active=${document.activeElement?.tagName ?? 'none'} hasFocus=${String(document.hasFocus())}`;
    });
    console.log(`[176 ${browser}] NO CHOOSER for ${fixture} after ${String(Date.now() - started)}ms: ${state}`);
    throw error;
  });
  console.log(`[176 ${browser}] chooser for ${fixture} after ${String(Date.now() - started)}ms`);
  await chooser.setFiles(resolve(MEDIA, fixture));
}
