import { describe, expect, it } from 'vitest';
import { socketConnection, socketDeliver, type SmtpSocket } from '../../src/mail/socket.ts';

// The Worker's SMTP connection (shyden-labs/shydesk#68): a Workers socket opened
// with STARTTLS to the mail host on 587, read in whole CRLF replies, upgraded
// in place, and always closed. Stood in by a socket fed from a script.

interface Log {
  written: string[];
  closed: number;
  upgradedWhileLocked: boolean;
  connectedTo?: unknown;
  options?: unknown;
}

/** A socket whose readable side gives `chunks`, then ends; what is written is logged. */
function socketOf(chunks: string[], log: Log, upgrade?: () => SmtpSocket): SmtpSocket {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const decoder = new TextDecoder();
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      log.written.push(decoder.decode(bytes));
    },
  });
  return {
    readable,
    writable,
    startTls: () => {
      log.upgradedWhileLocked = readable.locked || writable.locked;
      if (upgrade === undefined) throw new Error('no TLS in this stand-in');
      return upgrade();
    },
    close: () => {
      log.closed += 1;
      return Promise.resolve();
    },
  };
}

const freshLog = (): Log => ({ written: [], closed: 0, upgradedWhileLocked: false });

/**
 * A socket that answers each command as a mail server would, line by line.
 * The plain socket answers until STARTTLS; the upgraded one answers the rest.
 */
function serverSocket(log: Log, answers: { greeting?: string; rcpt?: string } = {}): SmtpSocket {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const make = (secure: boolean): SmtpSocket => {
    let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller;
        if (!secure) controller.enqueue(encoder.encode(answers.greeting ?? '220 mail.example ready\r\n'));
      },
    });
    const say = (text: string) => feed?.enqueue(encoder.encode(text));
    const writable = new WritableStream<Uint8Array>({
      write(bytes) {
        const text = decoder.decode(bytes);
        log.written.push(`${secure ? 'tls' : 'plain'}: ${text.split('\r\n')[0] ?? ''}`);
        if (text.startsWith('EHLO')) say(secure ? '250-mail.example\r\n250 AUTH PLAIN LOGIN\r\n' : '250-mail.example\r\n250 STARTTLS\r\n');
        else if (text.startsWith('STARTTLS')) say('220 go ahead\r\n');
        else if (text.startsWith('AUTH')) say('235 ok\r\n');
        else if (text.startsWith('MAIL')) say('250 ok\r\n');
        else if (text.startsWith('RCPT')) say(answers.rcpt ?? '250 ok\r\n');
        else if (text.startsWith('DATA')) say('354 go\r\n');
        else if (text.startsWith('QUIT')) say('221 bye\r\n');
        else say('250 queued\r\n');
      },
    });
    return {
      readable,
      writable,
      startTls: () => {
        log.upgradedWhileLocked = readable.locked || writable.locked;
        return make(true);
      },
      close: () => {
        log.closed += 1;
        return Promise.resolve();
      },
    };
  };
  return make(false);
}

const LOGIN = { user: 'no-reply@shytalk.example', pass: 'secret' };
const MAIL = { from: 'no-reply@shytalk.example', to: 'ana@example.com', subject: 'Your request', text: 'Hello' };

describe('socketConnection', () => {
  it('reads one reply without its CRLF', async () => {
    const connection = socketConnection(socketOf(['220 ready\r\n'], freshLog()));
    expect(await connection.readReply()).toEqual(['220 ready']);
  });

  it('joins the lines of a multi-line reply, even split across chunks', async () => {
    const connection = socketConnection(socketOf(['250-mail.example\r\n250-STA', 'RTTLS\r\n250 AUTH PLAIN\r\n'], freshLog()));
    expect(await connection.readReply()).toEqual(['250-mail.example', '250-STARTTLS', '250 AUTH PLAIN']);
  });

  it('keeps a second reply that came in the same chunk for the next read', async () => {
    const connection = socketConnection(socketOf(['250 one\r\n221 two\r\n'], freshLog()));
    expect(await connection.readReply()).toEqual(['250 one']);
    expect(await connection.readReply()).toEqual(['221 two']);
  });

  it('keeps a character whose bytes are split across chunks', async () => {
    const bytes = new TextEncoder().encode('220 café ready\r\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, cut));
        controller.enqueue(bytes.subarray(cut));
        controller.close();
      },
    });
    const socket: SmtpSocket = { ...socketOf([], freshLog()), readable };
    expect(await socketConnection(socket).readReply()).toEqual(['220 café ready']);
  });

  it('ends a reply on a bare three-digit code', async () => {
    const connection = socketConnection(socketOf(['250\r\n'], freshLog()));
    expect(await connection.readReply()).toEqual(['250']);
  });

  it('fails naming it when the server hangs up mid-reply', async () => {
    const connection = socketConnection(socketOf(['250-half\r\n'], freshLog()));
    await expect(connection.readReply()).rejects.toThrow('the mail server closed the connection before its reply ended');
  });

  it('fails rather than keep reading a reply that never ends', async () => {
    const endless = Array.from({ length: 70 }, () => `250-${'x'.repeat(1020)}\r\n`);
    const connection = socketConnection(socketOf(endless, freshLog()));
    await expect(connection.readReply()).rejects.toThrow('the mail server sent a reply over 64 KiB');
  });

  it('writes text as UTF-8 bytes', async () => {
    const log = freshLog();
    await socketConnection(socketOf([], log)).write('EHLO shydesk\r\n');
    expect(log.written).toEqual(['EHLO shydesk\r\n']);
  });

  it('upgrades with its streams released, then reads and writes on the upgraded socket', async () => {
    const tlsLog = freshLog();
    const log = freshLog();
    const plain = socketConnection(socketOf(['220 go ahead\r\n'], log, () => socketOf(['250 secure\r\n'], tlsLog)));
    expect(await plain.readReply()).toEqual(['220 go ahead']);
    const secure = await plain.startTls();
    expect(log.upgradedWhileLocked).toBe(false);
    expect(await secure.readReply()).toEqual(['250 secure']);
    await secure.write('AUTH\r\n');
    expect(tlsLog.written).toEqual(['AUTH\r\n']);
  });

  it('closes the socket, with its streams released', async () => {
    const log = freshLog();
    const connection = socketConnection(socketOf(['220 ready\r\n'], log));
    await connection.readReply();
    await connection.close();
    expect(log.closed).toBe(1);
  });
});

describe('socketDeliver', () => {
  it('opens the mail host on 587 with STARTTLS, sends the mail over TLS, and closes after QUIT', async () => {
    const log = freshLog();
    const deliver = socketDeliver((address, options) => {
      log.connectedTo = address;
      log.options = options;
      return serverSocket(log);
    });
    await deliver(LOGIN, MAIL, 'mail.example');
    expect(log.connectedTo).toEqual({ hostname: 'mail.example', port: 587 });
    expect(log.options).toEqual({ secureTransport: 'starttls', allowHalfOpen: false });
    expect(log.written.filter((line) => line.startsWith('plain:'))).toEqual(['plain: EHLO shydesk', 'plain: STARTTLS']);
    expect(log.written).toContain('tls: AUTH PLAIN AG5vLXJlcGx5QHNoeXRhbGsuZXhhbXBsZQBzZWNyZXQ=');
    expect(log.written.at(-1)).toBe('tls: QUIT');
    expect(log.upgradedWhileLocked).toBe(false);
    expect(log.closed).toBe(1);
  });

  it('closes the connection when the server refuses, and fails naming the step', async () => {
    const log = freshLog();
    const deliver = socketDeliver(() => serverSocket(log, { rcpt: '550 no such user\r\n' }));
    await expect(deliver(LOGIN, MAIL, 'mail.example')).rejects.toThrow('rcpt-to');
    expect(log.closed).toBe(1);
  });

  it('closes the connection when the greeting is a refusal', async () => {
    const log = freshLog();
    const deliver = socketDeliver(() => serverSocket(log, { greeting: '554 go away\r\n' }));
    await expect(deliver(LOGIN, MAIL, 'mail.example')).rejects.toThrow('greeting');
    expect(log.closed).toBe(1);
  });

  it('refuses to connect without a mail host', async () => {
    let connected = false;
    const deliver = socketDeliver(() => {
      connected = true;
      return serverSocket(freshLog());
    });
    await expect(deliver(LOGIN, MAIL, '')).rejects.toThrow('SMTP_HOST is not set');
    expect(connected).toBe(false);
  });
});
