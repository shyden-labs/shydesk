/**
 * An encrypted copy of a ticket's token, so a staff reply's email can carry the
 * customer's unchanged private link (Shyden's ruling, shyden-labs/shydesk#24).
 * Tickets are still found only by the token's hash. AES-256-GCM with a fresh
 * nonce per token; the key is the Worker secret TICKET_TOKEN_KEY (32 bytes,
 * base64), so a copy of the database alone opens no ticket.
 */

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function importKey(base64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(base64);
  } catch {
    throw new Error('TICKET_TOKEN_KEY is not base64');
  }
  if (raw.length !== KEY_BYTES) throw new Error(`TICKET_TOKEN_KEY must be ${String(KEY_BYTES)} bytes`);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The token encrypted under the key, as base64 of its nonce and ciphertext. */
export async function sealToken(key: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), new TextEncoder().encode(token));
  const sealed = new Uint8Array(NONCE_BYTES + cipher.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(cipher), NONCE_BYTES);
  return toBase64(sealed);
}

/** The token back; throws if the key is wrong or the sealed copy was altered. */
export async function openToken(key: string, sealed: string): Promise<string> {
  const bytes = fromBase64(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, NONCE_BYTES) },
    await importKey(key),
    bytes.slice(NONCE_BYTES),
  );
  return new TextDecoder().decode(plain);
}
