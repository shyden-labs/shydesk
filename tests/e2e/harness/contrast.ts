/**
 * How readable a field is, measured from the colours the browser computed for it
 * (shyden-labs/shydesk#282): typed text against its field at WCAG's 4.5:1 for text,
 * and a select's drawn arrow against its field at 3:1 for a needed graphic.
 */
import { strict as assert } from 'node:assert';
import { driver } from './driver.ts';
import { named } from './find.ts';

type Rgb = [number, number, number];

/** WCAG 2's least contrast for normal text. */
const TEXT_CONTRAST = 4.5;
/** WCAG 2's least contrast for a graphic a control needs, such as the select's arrow. */
const GRAPHIC_CONTRAST = 3;

/** The red, green and blue of a computed, fully opaque colour; refuses anything else by name. */
export function colourOf(computed: string): Rgb {
  const match = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\)$/.exec(computed.trim());
  if (match === null || (match[4] !== undefined && Number(match[4]) !== 1)) {
    throw new Error(`"${computed}" is not a fully opaque colour`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG 2's relative luminance of one colour. */
function luminance(colour: Rgb): number {
  const [r, g, b] = colour.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2's contrast ratio between two computed colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(colourOf(a)), luminance(colourOf(b))].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Every colour named in a computed background-image, in order. */
export function gradientColours(image: string): string[] {
  return image.match(/rgba?\([^)]*\)/g) ?? [];
}

/**
 * Fails, naming every shortfall at once, unless each field named in `labels` shows its text
 * at 4.5:1 against its own background and, for a select, draws its arrow at 3:1.
 */
export async function readable(labels: readonly string[]): Promise<void> {
  const short: string[] = [];
  for (const label of labels) {
    const style = await driver().execute<{ tag: string; color: string; background: string; image: string }>(
      'const s = getComputedStyle(arguments[0]); return { tag: arguments[0].tagName, color: s.color, background: s.backgroundColor, image: s.backgroundImage };',
      await named(label),
    );
    const text = contrastRatio(style.color, style.background);
    if (text < TEXT_CONTRAST) short.push(`"${label}" text ${style.color} on ${style.background} is ${text.toFixed(2)}:1`);
    if (style.tag === 'SELECT') {
      const arrow = gradientColours(style.image).filter((colour) => !/^rgba\(.*,\s*0\)$/.test(colour));
      if (arrow.length === 0) short.push(`"${label}" draws no arrow (${style.image})`);
      for (const colour of arrow) {
        const ratio = contrastRatio(colour, style.background);
        if (ratio < GRAPHIC_CONTRAST) short.push(`"${label}" arrow ${colour} on ${style.background} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(short, [], `under WCAG contrast: ${short.join('; ')}`);
}

/** One measured part of the form: words against what lies behind them, or a field's border against its surroundings. */
export interface Part {
  what: string;
  kind: 'text' | 'border';
  color: string;
  background: string;
}

/**
 * Every part under WCAG contrast, each naming its colours and ratio: words at 4.5:1, a field's
 * border at 3:1 as the graphic that shows where the field is (shyden-labs/shydesk#299).
 */
export function partShortfalls(parts: readonly Part[]): string[] {
  if (parts.length === 0) return ['no part of the form was found to measure'];
  const short: string[] = [];
  for (const part of parts) {
    const needed = part.kind === 'text' ? TEXT_CONTRAST : GRAPHIC_CONTRAST;
    const ratio = contrastRatio(part.color, part.background);
    if (ratio < needed) short.push(`${part.what} ${part.color} on ${part.background} is ${ratio.toFixed(2)}:1, needs ${String(needed)}:1`);
  }
  return short;
}

/**
 * Lists, from the support piece's shadow root, every shown label, status line, error, link and
 * enabled button with its text colour, and every field's border, each against the first opaque
 * background behind it (white if the page sets none, as a browser draws it).
 */
const LIST_PARTS = `
  const host = document.querySelector('shydesk-support');
  if (host === null || host.shadowRoot === null) return [];
  const root = host.shadowRoot;
  const opaque = (colour) => !/^rgba\\(.*,\\s*0\\)$/.test(colour) && colour !== 'transparent';
  const behind = (element) => {
    for (let at = element; at !== null; at = at.parentElement ?? (at.getRootNode() instanceof ShadowRoot ? at.getRootNode().host : null)) {
      const colour = getComputedStyle(at).backgroundColor;
      if (opaque(colour)) return colour;
    }
    return 'rgb(255, 255, 255)';
  };
  const shown = (element) => element.getClientRects().length > 0 && element.textContent.trim() !== '';
  const words = (element) => element.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40);
  const parts = [];
  for (const label of root.querySelectorAll('label')) {
    if (shown(label)) parts.push({ what: 'label "' + words(label) + '"', kind: 'text', color: getComputedStyle(label).color, background: behind(label) });
  }
  for (const element of root.querySelectorAll('[role=status], .error, a[href], button:not(.preview):not(:disabled)')) {
    if (!shown(element)) continue;
    const kind = element.matches('.error') ? 'error' : element.matches('a') ? 'link' : element.matches('button') ? 'button' : 'status';
    parts.push({ what: kind + ' "' + words(element) + '"', kind: 'text', color: getComputedStyle(element).color, background: behind(element) });
  }
  for (const field of root.querySelectorAll('input:not([type=file]):not([type=hidden]), select, textarea')) {
    if (field.getClientRects().length === 0) continue;
    const name = field.labels?.[0] ? words(field.labels[0]) : field.name;
    parts.push({ what: 'border of "' + name + '"', kind: 'border', color: getComputedStyle(field).borderTopColor, background: behind(field.parentElement) });
  }
  return parts;
`;

/** Fails, naming every shortfall at once, unless every shown word and field border on the form meets WCAG contrast. */
export async function everyPartReadable(): Promise<void> {
  const short = partShortfalls(await driver().execute<Part[]>(LIST_PARTS));
  assert.deepEqual(short, [], `under WCAG contrast: ${short.join('; ')}`);
}
