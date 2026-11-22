/**
 * Dev's test tickets (shyden-labs/shydesk#254, Shyden's ruling on shyden-labs/shyden.co.uk#1032):
 * shyden.co.uk's dev journey sends a real support request on every dev deploy, each from its own
 * plus-address. A ticket from `TEST_TICKET_PRODUCT` whose address matches `TEST_TICKET_EMAIL`
 * (where `*` stands for one or more characters other than `@`) is cleared by its own timer an hour
 * after creation. Only dev sets these vars, so on live nothing matches.
 */

export interface TestTicketSetting {
  TEST_TICKET_PRODUCT?: string;
  TEST_TICKET_EMAIL?: string;
}

/** Long enough for the journey to read its thread before the ticket goes. */
export const TEST_TICKET_CLEAR_MS = 3_600_000;

const escape = (text: string): string => text.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Whether a new ticket from this product and (lowercased) address is a dev test ticket. */
export function isTestTicket(setting: TestTicketSetting, productId: string, email: string): boolean {
  const { TEST_TICKET_PRODUCT: product, TEST_TICKET_EMAIL: pattern } = setting;
  if (!product || !pattern || productId !== product) return false;
  const source = pattern.toLowerCase().split('*').map(escape).join('[^@]+');
  return new RegExp(`^${source}$`).test(email);
}
