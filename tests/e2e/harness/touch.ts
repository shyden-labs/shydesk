/** The touch-size check every journey's form uses (shyden-labs/shydesk#256). */
import { strict as assert } from 'node:assert';
import { driver } from './driver.ts';
import { named } from './find.ts';

/**
 * Fails unless each control named in `labels` is drawn at least 44 × 44 px, the touch size
 * (shyden-labs/shydesk#256), naming every one that is not with the size it has on this browser.
 */
export async function touchSized(labels: readonly string[]): Promise<void> {
  const small: string[] = [];
  for (const label of labels) {
    const box = await driver().execute<{ width: number; height: number }>(
      'const r = arguments[0].getBoundingClientRect(); return { width: r.width, height: r.height };',
      await named(label),
    );
    if (box.width < 44 || box.height < 44) small.push(`"${label}" ${String(box.width)}×${String(box.height)}`);
  }
  assert.deepEqual(small, [], `under the 44 × 44 px touch size: ${small.join(', ')}`);
}
