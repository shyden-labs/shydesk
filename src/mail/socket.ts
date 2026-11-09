import type { Deliver } from './notify.ts';
import { sendSmtp, type SmtpConnection } from './smtp.ts';

/**
 * The Worker's SMTP connection (shyden-labs/shydesk#68): a socket from
 * `cloudflare:sockets`, opened with STARTTLS to the mail host on port 587,
 * read in whole CRLF replies and upgraded in place. `sendSmtp` runs the
 * dialogue over it and always closes it, after QUIT or after any failure.
 */

/** The parts of a Workers `Socket` the connection uses. */
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): SmtpSocket;
  close(): Promise<void>;
}

/** `connect` from `cloudflare:sockets`, narrowed to what is used here. */
export type Connect = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'starttls'; allowHalfOpen: false },
) => SmtpSocket;

/** More than any real reply: a server that keeps going is stopped, not buffered without end. */
const MAX_REPLY_CHARS = 64 * 1024;

/** The last line of a reply: a code followed by a space, or the code alone. */
const LAST_LINE = /^\d{3}(?: |$)/;

/** A whole reply at the start of `buffered`: its lines and where it ends, or null if it has not all come yet. */
function wholeReply(buffered: string): { lines: string[]; end: number } | null {
  const lines: string[] = [];
  let at = 0;
  for (let cut = buffered.indexOf('\r\n'); cut !== -1; cut = buffered.indexOf('\r\n', at)) {
    const line = buffered.slice(at, cut);
    lines.push(line);
    at = cut + 2;
    if (LAST_LINE.test(line)) return { lines, end: at };
  }
  return null;
}

/** An SmtpConnection over `socket`. */
export function socketConnection(socket: SmtpSocket): SmtpConnection {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';

  /** Lets go of both streams, as the runtime asks before an upgrade or close. */
  const release = (): void => {
    reader.releaseLock();
    writer.releaseLock();
  };

  return {
    async readReply() {
      for (;;) {
        const reply = wholeReply(buffered);
        if (reply !== null) {
          buffered = buffered.slice(reply.end);
          return reply.lines;
        }
        if (buffered.length > MAX_REPLY_CHARS) throw new Error('the mail server sent a reply over 64 KiB');
        const { done, value } = await reader.read();
        if (done) throw new Error('the mail server closed the connection before its reply ended');
        buffered += decoder.decode(value, { stream: true });
      }
    },
    async write(text) {
      await writer.write(encoder.encode(text));
    },
    startTls() {
      release();
      return Promise.resolve(socketConnection(socket.startTls()));
    },
    async close() {
      release();
      await socket.close();
    },
  };
}

/**
 * A Deliver that sends each mail through the mail host named by the Worker's
 * SMTP_HOST setting, over a fresh STARTTLS socket on port 587.
 */
export function socketDeliver(connect: Connect): Deliver {
  return async (login, mail, host) => {
    if (!host) throw new Error('SMTP_HOST is not set');
    const socket = connect({ hostname: host, port: 587 }, { secureTransport: 'starttls', allowHalfOpen: false });
    await sendSmtp(socketConnection(socket), login, mail, new Date());
  };
}
