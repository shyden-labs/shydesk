import { driver } from './driver.ts';
import { JOURNEY_WAIT, named } from './find.ts';

/** The text of the element named `label` once it holds `expected`, or a failure showing what it held. */
export async function textHolding(label: string, expected: string, timeout = JOURNEY_WAIT): Promise<string> {
  const element = await named(label);
  let text = '';
  const never = `"${label}" never held "${expected}"`;
  try {
    await driver().waitUntil(
      async () => {
        text = await element.getText();
        return text.includes(expected);
      },
      { timeout, timeoutMsg: never },
    );
  } catch (error) {
    // The wait's own message is fixed before it reads anything, so the text last read is added here (shyden-labs/shydesk#294).
    if (error instanceof Error && error.message === never) throw new Error(`${never}; it held "${text}"`, { cause: error });
    throw error;
  }
  return text;
}
