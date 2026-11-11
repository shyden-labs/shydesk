/**
 * What the shared support piece shows when a test fails, printed to the run's
 * log: each field's value and every line of text it draws. On PR
 * shyden-labs/shydesk#69 and shyden-labs/shydesk#70 a failure said only that the status line
 * held "", and each cause (a field filled wrong, a request refused) took a
 * probe run to find. This reads the page only; it sends no input.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { driver } from './driver.ts';
import { targetOf } from './targets.ts';

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

/**
 * What the screen showed when a test failed: on a phone a screenshot and
 * the native tree, saved beside the run's records. The keyboard covering
 * Send and the names iOS gives controls were each found this way
 * (shyden-labs/shydesk#73); a dialog over the page would show here too.
 */
export async function saveFailureScreen(dir: string, title: string): Promise<void> {
  const target = targetOf(driver().capabilities);
  const name = join(dir, `${target}-${title.replace(/\W+/g, '-').slice(0, 60)}`);
  if (target !== 'android' && target !== 'ios') {
    // A desktop browser's window at the failure, its own video controls included (shyden-labs/shydesk#108).
    await driver().saveScreenshot(`${name}.png`);
    console.log(`${target}: the window at the failure is in ${name}.png`);
    return;
  }
  const page = await driver().getContext();
  try {
    await driver().switchContext('NATIVE_APP');
    writeFileSync(`${name}.xml`, await driver().getPageSource());
    await driver().saveScreenshot(`${name}.png`);
    console.log(`${target}: the screen at the failure is in ${name}.png and ${name}.xml`);
  } catch (error) {
    console.log(`${target}: could not save the screen: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
  } finally {
    await driver().switchContext(typeof page === 'string' ? page : page.id);
  }
}
