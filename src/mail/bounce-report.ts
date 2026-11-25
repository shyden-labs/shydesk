/**
 * Reads a failed delivery report (RFC 3464) into the status and the server's
 * reason the desk shows (shyden-labs/shydesk#232). Only a
 * `multipart/report; report-type=delivery-status` whose recipient block says
 * `Action: failed` counts: auto-replies, delay notices and other reports give
 * null. No mail library: the report's own structure is plain header blocks.
 */

/** The most kept of a status or a reason, so one report cannot fill the row. */
const MOST = 500;

export interface Bounce {
  status: string;
  reason: string;
}

/** A header block, unfolded: a line starting with a space or tab continues the one before (RFC 5322 2.2.3). */
function headers(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of block.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) found.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return found;
}

/** A Content-Type's parameter, case-insensitive, quoted or not. */
function parameter(contentType: string, name: string): string | undefined {
  const match = new RegExp(String.raw`;\s*${name}\s*=\s*(?:"([^"]*)"|([^;\s]+))`, 'i').exec(contentType);
  return match?.[1] ?? match?.[2];
}

/** The header block and the body, split at the first empty line; null when there is none. */
function split(text: string): { head: string; body: string } | null {
  const end = text.indexOf('\n\n');
  return end === -1 ? null : { head: text.slice(0, end), body: text.slice(end + 2) };
}

/** The failed recipient's status and reason (its `smtp;` type dropped), each cut to 500 characters; null if none failed. */
function failedRecipient(deliveryStatus: string): Bounce | null {
  // The first block is about the message; each one after it is about one recipient.
  for (const block of deliveryStatus.split(/\n[ \t]*\n/).slice(1)) {
    const fields = headers(block);
    if (fields.get('action')?.toLowerCase() !== 'failed') continue;
    return {
      status: (fields.get('status') ?? '').slice(0, MOST),
      reason: (fields.get('diagnostic-code') ?? '').replace(/^[a-z0-9-]+;\s*/i, '').slice(0, MOST),
    };
  }
  return null;
}

export function readBounce(raw: string): Bounce | null {
  const message = split(raw.replaceAll('\r\n', '\n'));
  if (message === null) return null;
  const contentType = headers(message.head).get('content-type') ?? '';
  if (!/^multipart\/report\b/i.test(contentType)) return null;
  if (parameter(contentType, 'report-type')?.toLowerCase() !== 'delivery-status') return null;
  const boundary = parameter(contentType, 'boundary');
  if (boundary === undefined) return null;
  for (const part of message.body.split(`--${boundary}`)) {
    const piece = split(part.replace(/^\n/, ''));
    if (piece !== null && /^message\/delivery-status\b/i.test(headers(piece.head).get('content-type') ?? '')) {
      return failedRecipient(piece.body);
    }
  }
  return null;
}
