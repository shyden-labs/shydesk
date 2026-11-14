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
import { drawnAt, inDocument, iosNamed, iosPage, largest, nameMatches, notNamedMessage, targetOf, type Box } from './targets.ts';
import { labelledFirst } from './labelled-first.ts';

const WAIT = 15_000;

/** How long to leave the page between lookups while waiting for an element to appear. */
const LOOK_AGAIN_MS = 250;

/** Elements that can carry a name: controls, links, and anything with a role or a label. */
const CANDIDATES = 'input, textarea, select, button, a[href], output, [role], [aria-label], [aria-labelledby]';

const LIST_CANDIDATES = `
  const found = [];
  const walk = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.matches(arguments[0])) found.push({ element, tag: element.localName, file: element.matches('input[type=file]') });
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return found;
`;

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** The page's title and zoom, and every candidate with its box in the document, in CSS pixels. */
const LIST_PLACED = `
  const found = [];
  // The names the page gives an element itself: its aria-label, alt and text.
  const labelsOf = (element) =>
    [element.getAttribute('aria-label'), element.getAttribute('alt'), element.textContent].filter((own) => own !== null);
  const walk = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.matches(arguments[0])) {
        const r = element.getBoundingClientRect();
        found.push({ element, labels: labelsOf(element), box: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height } });
      }
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return { title: document.title, width: document.documentElement.scrollWidth, candidates: found };
`;

interface Placed {
  title: string;
  /** The document's width in CSS pixels, against the page area's width in native points for the zoom. */
  width: number;
  /** `labels` are the names the page gives the element itself: its `aria-label`, `alt` and text. */
  candidates: { element: ElementReference; labels: string[]; box: Box }[];
}

async function boxOf(element: Element): Promise<Box> {
  return { ...(await element.getLocation()), ...(await element.getSize()) };
}

/**
 * On the iPhone (shyden-labs/shydesk#73): the ids of the page elements drawn
 * where iOS shows a control named `label`, and every name iOS gave. iOS names
 * each control in its native tree (the name VoiceOver reads); the page
 * element is the candidate drawn in that same place in the document.
 */
async function idsNamedOnIphone(label: string): Promise<{ ids: string[]; seen: string[] }> {
  const { title, width, candidates } = await driver().execute<Placed>(LIST_PLACED, CANDIDATES);
  const page = await driver().getContext();
  await driver().switchContext('NATIVE_APP');
  let area: Box | undefined;
  const places: Box[] = [];
  const seen: string[] = [];
  try {
    // A plain loop: WebdriverIO's element list has its own `map`, which returns a promise, not an array.
    const areas: Box[] = [];
    for (const each of await driver().$$(iosPage(title))) areas.push(await boxOf(each));
    area = largest(areas);
    for (const control of await driver().$$(iosNamed(label))) {
      seen.push((await control.getAttribute('label')) ?? '');
      places.push(await boxOf(control));
    }
  } finally {
    await driver().switchContext(typeof page === 'string' ? page : page.id);
  }
  if (area === undefined) throw new Error(`ios: the page area named "${title}" is not in the native tree (${iosPage(title)})`);
  const pageArea = area;
  const scale = width / pageArea.width;
  const drawn = candidates.flatMap(({ box }, index) =>
    places.some((place) => drawnAt(inDocument(place, pageArea, scale), box)) ? [index] : [],
  );
  const ids = labelledFirst(
    label,
    drawn,
    candidates.map(({ labels }) => labels),
  ).map((index) => candidates[index]?.element[ELEMENT_KEY] ?? '');
  return { ids, seen };
}

interface Candidate {
  element: ElementReference;
  tag: string;
  file: boolean;
}

/**
 * The ids of every element on the page whose accessible name is `label`, and
 * every name seen. An element the browser will not name (Safari answered
 * "unknown error" for one on PR shyden-labs/shydesk#69) cannot be the one
 * named `label`; it is listed by its tag and the browser's answer instead.
 */
async function idsNamed(label: string): Promise<{ ids: string[]; seen: string[] }> {
  if (targetOf(driver().capabilities) === 'ios') return idsNamedOnIphone(label);
  const candidates = await driver().execute<Candidate[]>(LIST_CANDIDATES, CANDIDATES);
  const ids: string[] = [];
  const seen: string[] = [];
  for (const { element, tag, file } of candidates) {
    const id = element[ELEMENT_KEY];
    let name: string;
    try {
      name = await driver().getElementComputedLabel(id);
    } catch (error) {
      seen.push(`<${tag}> the browser could not name (${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)})`);
      continue;
    }
    seen.push(name);
    if (nameMatches(label, name, file)) ids.push(id);
  }
  return { ids, seen };
}

/**
 * The one element named `label`, once it is on the page. Fails naming the
 * label if none appears in time, or at once if more than one has that name.
 */
export async function named(label: string): Promise<Element> {
  let ids: string[] = [];
  let seen: string[] = [];
  // A lookup that throws is tried again until the wait ends, so its error is kept for the failure.
  let failure: string | undefined;
  // The deadline is checked only between whole lookups: a lookup cut off midway could be left in
  // the phone's native layer, and every later page script would then fail (measured on the iPhone, shyden-labs/shydesk#73).
  const deadline = Date.now() + WAIT;
  for (;;) {
    try {
      ({ ids, seen } = await idsNamed(label));
      failure = undefined;
    } catch (error) {
      failure = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    }
    if (ids.length > 1) throw new Error(`${String(ids.length)} elements are named "${label}"; a test names exactly one`);
    const [id] = ids;
    if (id !== undefined) return driver().$({ [ELEMENT_KEY]: id });
    // The names the browser did give, so a failure shows what each target calls the element.
    if (Date.now() >= deadline) throw new Error(notNamedMessage(label, seen, failure));
    await new Promise((resolve) => setTimeout(resolve, LOOK_AGAIN_MS));
  }
}
