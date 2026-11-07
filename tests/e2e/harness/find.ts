/**
 * Finds a page element by its accessible name, inside open shadow roots too
 * (the shared support piece draws its form in one, shyden-labs/shydesk#19).
 *
 * WebdriverIO's `aria/` lookup does not reach shadow roots the same way on
 * every target (measured on PR shyden-labs/shydesk#69, 2026-11-07): Chrome
 * found the support piece's fields, Firefox found two elements for "Email",
 * and Safari found none. Here the page lists its candidate elements, light
 * DOM and every open shadow root alike, and the browser itself names each one
 * through WebDriver's Get Computed Label, so the name is the browser's own on
 * every target. The lookup only reads; input stays real WebDriver input.
 */
import { driver, type Element, type ElementReference } from './driver.ts';

const WAIT = 15_000;

/** Elements that can carry a name: controls, links, and anything with a role or a label. */
const CANDIDATES = 'input, textarea, select, button, a[href], output, [role], [aria-label], [aria-labelledby]';

const LIST_CANDIDATES = `
  const found = [];
  const walk = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.matches(arguments[0])) found.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return found;
`;

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** The ids of every element on the page whose accessible name is `label`. */
async function idsNamed(label: string): Promise<string[]> {
  const candidates = await driver().execute<ElementReference[]>(LIST_CANDIDATES, CANDIDATES);
  const ids: string[] = [];
  for (const candidate of candidates) {
    const id = candidate[ELEMENT_KEY];
    if ((await driver().getElementComputedLabel(id)) === label) ids.push(id);
  }
  return ids;
}

/**
 * The one element named `label`, once it is on the page. Fails naming the
 * label if none appears in time, or at once if more than one has that name.
 */
export async function named(label: string): Promise<Element> {
  let ids: string[] = [];
  await driver().waitUntil(
    async () => {
      ids = await idsNamed(label);
      if (ids.length > 1) throw new Error(`${String(ids.length)} elements are named "${label}"; a test names exactly one`);
      return ids.length === 1;
    },
    { timeout: WAIT, timeoutMsg: `no element named "${label}" appeared on the page` },
  );
  const [id] = ids;
  if (id === undefined) throw new Error(`no element named "${label}" appeared on the page`);
  return driver().$({ [ELEMENT_KEY]: id });
}
