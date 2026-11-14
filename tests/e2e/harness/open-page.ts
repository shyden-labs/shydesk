import { driver } from './driver.ts';
import { pageLoadStalled, targetOf } from './targets.ts';

/**
 * Opens `url` and fails at once, naming why, when the iPhone's Safari never
 * answered the load (shyden-labs/shydesk#146); otherwise later page scripts
 * would hang and end in a false "modal dialog" error.
 */
export async function openPage(url: string): Promise<void> {
  const started = performance.now();
  await driver().url(url);
  const stalled = pageLoadStalled(targetOf(driver().capabilities), url, Math.round(performance.now() - started));
  if (stalled !== undefined) throw new Error(stalled);
}
