/**
 * Tickets from a product's TEST site (shyden-labs/shydesk#263; Shyden 2026-11-22):
 * they reach the live desk marked TEST, link to the TEST site's own ticket page,
 * and their customer is told the test version is answered after the live one.
 */

/** The reply a TEST site's customer gets, in the wording Shyden approved on 2026-11-22. */
export const testSiteReply = (productName: string): string =>
  `Thanks for trying the test version of ${productName}. Your message has arrived safely. ` +
  `Requests from the live version of ${productName} are always answered first, so messages from the test version ` +
  `have no set reply time and may not always get a reply. Every report still helps make ${productName} better.`;

/** The product's ticket page, moved onto the TEST site the ticket came from; the live page for a live ticket. */
export function ticketPageFor(ticketPageUrl: string, testOrigin: string | null): string {
  if (testOrigin === null) return ticketPageUrl;
  const page = new URL(ticketPageUrl);
  return `${testOrigin}${page.pathname}${page.search}`;
}
