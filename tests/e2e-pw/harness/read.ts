/**
 * Reading the page for the Playwright suite (shyden-labs/shydesk#176): text found by the
 * accessible name a person would read, and the touch size of controls.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** How long a journey waits for a page to show what it should, as the WebdriverIO suite does. */
export const JOURNEY_WAIT = 20_000;

/** The one element named `label`, by its label or aria-label; strict mode fails on more than one. */
function named(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

/**
 * The text of the element named `label` once it holds `expected`, or a failure naming the
 * text it last held (keeps shyden-labs/shydesk#294's behaviour).
 */
export async function textHolding(page: Page, label: string, expected: string): Promise<string> {
  const element = named(page, label);
  let text = '';
  await expect
    .poll(
      async () => {
        text = (await element.innerText()).trim();
        return text.includes(expected);
      },
      { timeout: JOURNEY_WAIT, message: `"${label}" never held "${expected}"` },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(`"${label}" never held "${expected}"; it held "${text}"`, { cause: error });
    });
  return text;
}

/**
 * Fails unless each control named in `labels` is drawn at least 44 × 44 px, the touch size
 * (shyden-labs/shydesk#256), naming every one that is not with the size it has on this browser.
 */
export async function touchSized(page: Page, labels: readonly string[]): Promise<void> {
  const small: string[] = [];
  for (const label of labels) {
    const field = page.getByLabel(label, { exact: true });
    const control = (await field.count()) > 0 ? field : page.getByRole('button', { name: label, exact: true });
    const box = await control.boundingBox();
    if (box === null) small.push(`"${label}" not drawn`);
    else if (box.width < 44 || box.height < 44) small.push(`"${label}" ${String(box.width)}×${String(box.height)}`);
  }
  expect(small, `under the 44 × 44 px touch size: ${small.join(', ')}`).toEqual([]);
}
