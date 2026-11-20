/** No whitespace or @ from start to end, once on each side of a single @. */
const ONE_AT = /^[^\s@]+@[^\s@]+$/;

/**
 * Whether `value` is an email address ending in a domain: one @, no whitespace,
 * and a dot in the domain that is neither its first nor its last character.
 * Accepts exactly what `^[^\s@]+@[^\s@]+\.[^\s@]+$` accepted, but in linear time:
 * that pattern backtracks and took seconds on a long hostile input
 * (shyden-labs/shydesk#184).
 */
export function isEmailAddress(value: string): boolean {
  if (!ONE_AT.test(value)) return false;
  const domain = value.slice(value.indexOf('@') + 1);
  return domain.slice(1, -1).includes('.');
}
