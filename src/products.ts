/**
 * Products and their settings, kept by admins on screen so self-hosters
 * configure ShyDesk without a deploy (shyden-labs/shydesk#17; plan Task 4).
 */

/** A product as an admin enters it. */
export interface ProductInput {
  /** Stable id used in URLs and the shared piece's `product` attribute. */
  id: string;
  name: string;
  /** The no-reply address customer emails come from, on the product's own domain. */
  senderAddress: string;
  /** The product's page that shows a ticket from its private link. */
  ticketPageUrl: string;
  /** Exact `https://host[:port]` origins allowed to embed the shared piece. */
  allowedOrigins: string[];
  /** ShyDesk's own monthly email cap for this product. */
  monthlyEmailShare: number;
  attachmentsKeepDays: number;
  textKeepDays: number;
}

const PRODUCT_ID = /^[a-z0-9-]{2,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9.-]+$/;

/** True when `id` is a valid product id. */
export const isProductId = (id: string): boolean => PRODUCT_ID.test(id);

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** True when `origin` is written exactly as its own canonical `https://host[:port]`. */
export function isExactOrigin(origin: string): boolean {
  const url = parse(origin);
  return url !== null && url.protocol === 'https:' && HOST.test(url.hostname) && url.origin === origin;
}

const isWhole = (n: number, min: number): boolean => Number.isInteger(n) && n >= min;

/** Every rule the product breaks, in form order; empty when it is valid. */
export function validateProduct(p: ProductInput): string[] {
  const errors: string[] = [];
  if (!isProductId(p.id)) errors.push('Product id must be 2 to 40 lowercase letters, digits or hyphens.');
  if (!p.name.trim()) errors.push('Name is required.');
  if (!EMAIL.test(p.senderAddress)) errors.push('Sender address must be an email address ending in a domain.');
  const page = parse(p.ticketPageUrl);
  const pageOk = page !== null && page.protocol === 'https:' && !p.ticketPageUrl.includes('#');
  if (!pageOk) errors.push('Ticket page URL must be an https address with no #fragment.');
  if (p.allowedOrigins.length === 0) errors.push('At least one allowed origin is required.');
  for (const origin of p.allowedOrigins) {
    if (!isExactOrigin(origin)) errors.push(`Allowed origin "${origin}" must be exactly https://host or https://host:port.`);
  }
  if (pageOk && p.allowedOrigins.length > 0 && !p.allowedOrigins.includes(page.origin)) {
    errors.push("The ticket page URL's origin must be one of the allowed origins.");
  }
  if (!isWhole(p.monthlyEmailShare, 0)) errors.push('Monthly email share must be a whole number of 0 or more.');
  if (!isWhole(p.attachmentsKeepDays, 1)) errors.push('Attachment keep-days must be a whole number of 1 or more.');
  if (!isWhole(p.textKeepDays, 1)) errors.push('Text keep-days must be a whole number of 1 or more.');
  return errors;
}
