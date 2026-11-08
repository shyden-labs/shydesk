/**
 * What the shared support piece shows when a test fails, printed to the run's
 * log: each field's value and every line of text it draws. On PR
 * shyden-labs/shydesk#69 and shyden-labs/shydesk#70 a failure said only that the status line
 * held "", and each cause (a field filled wrong, a request refused) took a
 * probe run to find. This reads the page only; it sends no input.
 */
import { driver } from './driver.ts';

const READ_SUPPORT_PIECE = `
  const host = document.querySelector('shydesk-support');
  if (host === null || host.shadowRoot === null) return 'no support piece on the page (' + location.href + ')';
  const root = host.shadowRoot;
  const nameOf = (control) => {
    const label = control.id ? root.querySelector('label[for="' + control.id + '"]') : control.closest('label');
    return control.getAttribute('aria-label') || (label && [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()) || control.name || control.localName;
  };
  const fields = [...root.querySelectorAll('input, textarea, select')].map((c) => nameOf(c) + '=' + JSON.stringify(c.value));
  const texts = [...root.querySelectorAll('p, span, a, button, output, [role]')]
    .map((e) => e.textContent.trim())
    .filter((t, i, all) => t.length > 0 && all.indexOf(t) === i);
  return 'fields: ' + fields.join(', ') + ' | text: ' + texts.map((t) => JSON.stringify(t)).join(', ');
`;

/** The support piece's state, or why it could not be read. */
export async function supportPieceState(): Promise<string> {
  try {
    return await driver().execute<string>(READ_SUPPORT_PIECE);
  } catch (error) {
    return `could not read the support piece: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`;
  }
}
