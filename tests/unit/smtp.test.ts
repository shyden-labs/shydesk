import { describe, it, expect } from 'vitest';
import { sendSmtp, SmtpError, type SmtpConnection, type SmtpMail } from '../../src/mail/smtp.ts';

/**
 * The SMTP submission dialogue on port 587 (shyden-labs/shydesk#18): a
 * stood-in connection plays the server, so no socket is opened. Each server
 * reply is keyed by the command that draws it.
 */

type Script = Record<string, string>;

const HAPPY: Script = {
  greeting: '220 mail.example ESMTP',
  'EHLO shyden.co.uk': '250-mail.example\r\n250-STARTTLS\r\n250 SIZE 52428800',
  STARTTLS: '220 Ready to start TLS',
  'EHLO shyden.co.uk (tls)': '250-mail.example\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 52428800',
  AUTH: '235 Authentication succeeded',
  'MAIL FROM': '250 OK',
  'RCPT TO': '250 Accepted',
  DATA: '354 Enter message',
  '.': '250 OK id=1',
  QUIT: '221 bye',
};

class StandIn implements SmtpConnection {
  readonly sent: string[] = [];
  tls = false;
  closed = false;
  private queue: string[] = [];
  private readonly script: Script;

  constructor(script: Script, upgraded = false) {
    this.script = script;
    this.tls = upgraded;
    if (!upgraded) this.queue.push(this.reply('greeting'));
  }

  private reply(key: string): string {
    const text = this.script[key];
    if (text === undefined) throw new Error(`stand-in has no reply for ${key}`);
    return text;
  }

  private keyFor(line: string): string {
    if (line.startsWith('EHLO')) return this.tls ? `${line} (tls)` : line;
    if (line.startsWith('AUTH')) return 'AUTH';
    if (line.startsWith('MAIL FROM')) return 'MAIL FROM';
    if (line.startsWith('RCPT TO')) return 'RCPT TO';
    if (line.endsWith('\r\n.')) return '.';
    return line;
  }

  readReply(): Promise<string[]> {
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error('stand-in: read with nothing sent'));
    return Promise.resolve(next.split('\r\n'));
  }

  write(text: string): Promise<void> {
    if (!text.endsWith('\r\n')) return Promise.reject(new Error('stand-in: line without CRLF'));
    const line = text.slice(0, -2);
    this.sent.push(line);
    this.queue.push(this.reply(this.keyFor(line)));
    return Promise.resolve();
  }

  startTls(): Promise<SmtpConnection> {
    this.tls = true;
    return Promise.resolve(this);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** A stand-in whose socket breaks at one point after the dialogue: QUIT's write, QUIT's reply, or close. */
class Failing extends StandIn {
  private readonly breaks: 'quit-write' | 'quit-read' | 'close';
  private quitSent = false;

  constructor(script: Script, breaks: 'quit-write' | 'quit-read' | 'close') {
    super(script);
    this.breaks = breaks;
  }

  override write(text: string): Promise<void> {
    if (text === 'QUIT\r\n') {
      this.quitSent = true;
      if (this.breaks === 'quit-write') return Promise.reject(new Error('socket reset'));
    }
    return super.write(text);
  }

  override readReply(): Promise<string[]> {
    if (this.quitSent && this.breaks === 'quit-read') return Promise.reject(new Error('socket reset'));
    return super.readReply();
  }

  override close(): Promise<void> {
    void super.close();
    if (this.breaks === 'close') return Promise.reject(new Error('socket reset'));
    return Promise.resolve();
  }
}

const login = { user: 'no-reply@shyden.co.uk', pass: 'secret-pass' };
const mail: SmtpMail = {
  from: 'no-reply@shyden.co.uk',
  to: 'customer@example.com',
  subject: 'Your support request: something new',
  text: 'There is a new update on your support request.\nOpen it here: https://shyden.co.uk/support/t/abc',
};
const now = new Date('2026-11-05T01:02:03Z');

describe('sendSmtp', () => {
  it('runs EHLO, STARTTLS, EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA and QUIT in order, then closes', async () => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, mail, now);
    const commands = server.sent.map((line) => (line.includes('\r\n') ? '<message>' : line));
    expect(commands).toEqual([
      'EHLO shyden.co.uk',
      'STARTTLS',
      'EHLO shyden.co.uk',
      `AUTH PLAIN ${btoa('\0no-reply@shyden.co.uk\0secret-pass')}`,
      'MAIL FROM:<no-reply@shyden.co.uk>',
      'RCPT TO:<customer@example.com>',
      'DATA',
      '<message>',
      'QUIT',
    ]);
    expect(server.closed).toBe(true);
  });

  it("greets with the sender address's domain both times, never the bare name shydesk (shyden-labs/shydesk#233)", async () => {
    const script: Script = {
      ...HAPPY,
      'EHLO yaweloidle.com': '250-mail.example\r\n250-STARTTLS\r\n250 SIZE 52428800',
      'EHLO yaweloidle.com (tls)': '250-mail.example\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 52428800',
    };
    const server = new StandIn(script);
    await sendSmtp(server, login, { ...mail, from: 'no-reply@yaweloidle.com' }, now);
    expect(server.sent.filter((line) => line.startsWith('EHLO'))).toEqual(['EHLO yaweloidle.com', 'EHLO yaweloidle.com']);
    expect(server.sent.some((line) => line.includes('shydesk'))).toBe(false);
  });

  it('sends the headers and the body with CRLF line ends, ending in a lone dot', async () => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, mail, now);
    const message = server.sent.find((line) => line.includes('\r\n')) ?? '';
    const lines = message.split('\r\n');
    expect(lines.slice(0, 4)).toEqual([
      'From: no-reply@shyden.co.uk',
      'To: customer@example.com',
      'Subject: Your support request: something new',
      'Date: Thu, 05 Nov 2026 01:02:03 GMT',
    ]);
    expect(lines[4]).toMatch(/^Message-ID: <[0-9a-f-]{36}@shyden\.co\.uk>$/);
    expect(lines.slice(5, 9)).toEqual([
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
    ]);
    expect(lines.slice(9)).toEqual([
      'There is a new update on your support request.',
      'Open it here: https://shyden.co.uk/support/t/abc',
      '.',
    ]);
  });

  // A body line starting with a dot would otherwise end the message early (RFC 5321 4.5.2).
  it('doubles a dot at the start of a body line', async () => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, { ...mail, text: '.\n.hidden\nok.' }, now);
    const lines = (server.sent.find((line) => line.includes('\r\n')) ?? '').split('\r\n');
    expect(lines.slice(-4)).toEqual(['..', '..hidden', 'ok.', '.']);
  });

  // SMTP smuggling: a bare CR or LF must not leave `\r.\r` or `\n.\n` for a lax server to read as the end.
  it('turns every bare CR and LF in the body into CRLF before dot-stuffing', async () => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, { ...mail, text: 'a\r.\rb\n.\nc\r\n.end' }, now);
    const lines = (server.sent.find((line) => line.includes('\r\n')) ?? '').split('\r\n');
    expect(lines.slice(-7)).toEqual(['a', '..', 'b', '..', 'c', '..end', '.']);
    expect(lines.every((line) => !/[\r\n]/.test(line))).toBe(true);
  });

  it('encodes a subject with non-ASCII characters as RFC 2047 UTF-8 base64', async () => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, { ...mail, subject: 'Yawelo Idle: ¡novedad!' }, now);
    const lines = (server.sent.find((line) => line.includes('\r\n')) ?? '').split('\r\n');
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode('Yawelo Idle: ¡novedad!')));
    expect(lines[2]).toBe(`Subject: =?UTF-8?B?${encoded}?=`);
  });

  // Bounces come back to the envelope sender, not the From: address (shyden-labs/shydesk#232).
  it('uses envelopeFrom for MAIL FROM and keeps From: as the sender', async () => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, { ...mail, envelopeFrom: 'bounce-1@bounce.example' }, now);
    expect(server.sent).toContain('MAIL FROM:<bounce-1@bounce.example>');
    const lines = (server.sent.find((line) => line.includes('\r\n')) ?? '').split('\r\n');
    expect(lines).toContain('From: no-reply@shyden.co.uk');
    expect(server.sent.some((line) => line.startsWith('MAIL FROM:<no-reply@'))).toBe(false);
  });

  it('uses from for MAIL FROM when envelopeFrom is absent', async () => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, mail, now);
    expect(server.sent).toContain('MAIL FROM:<no-reply@shyden.co.uk>');
  });

  it.each([
    ['bounce-1@bounce.example\r\nRCPT TO:<b@example.com>', 'envelopeFrom holds a line break'],
    ['bounce-1@bounce.example\n', 'envelopeFrom holds a line break'],
    ['not-an-address', 'envelopeFrom is not a plain address'],
    ['<bounce-1@bounce.example>', 'envelopeFrom is not a plain address'],
  ])('refuses the envelopeFrom %j before opening the dialogue', async (envelopeFrom, reason) => {
    const server = new StandIn(HAPPY);
    await expect(sendSmtp(server, login, { ...mail, envelopeFrom }, now)).rejects.toThrow(new SmtpError('input', reason));
    expect(server.sent).toEqual([]);
  });

  // A From: with the product's name, not a bare address, reads as a real sender to spam filters (shyden-labs/shydesk#275).
  it.each([
    ['ShyTalk support', 'From: "ShyTalk support" <no-reply@shyden.co.uk>'],
    ['Say "hi" \\ support', 'From: "Say \\"hi\\" \\\\ support" <no-reply@shyden.co.uk>'],
    ['Dukungan Ýawelo', `From: =?UTF-8?B?${Buffer.from('Dukungan Ýawelo').toString('base64')}?= <no-reply@shyden.co.uk>`],
  ])('names the sender %j in the From: header', async (fromName, header) => {
    const server = new StandIn(HAPPY);
    await sendSmtp(server, login, { ...mail, fromName }, now);
    const lines = (server.sent.find((line) => line.includes('\r\n')) ?? '').split('\r\n');
    expect(lines[0]).toBe(header);
    expect(server.sent).toContain('MAIL FROM:<no-reply@shyden.co.uk>');
  });

  // Header injection: a CR or LF would start a new header or command.
  it.each([
    ['subject', { subject: 'Hi\r\nBcc: x@example.com' }],
    ['subject', { subject: 'Hi\nBcc: x@example.com' }],
    ['to', { to: 'a@example.com\r\nRCPT TO:<b@example.com>' }],
    ['from', { from: 'a@example.com\n' }],
    ['fromName', { fromName: 'ShyTalk support\r\nBcc: x@example.com' }],
  ])('refuses a CR or LF in the %s before opening the dialogue', async (field, change) => {
    const server = new StandIn(HAPPY);
    await expect(sendSmtp(server, login, { ...mail, ...change }, now)).rejects.toThrow(
      new SmtpError('input', `${field} holds a line break`),
    );
    expect(server.sent).toEqual([]);
    expect(server.closed).toBe(true);
  });

  it.each([
    'no-at-sign',
    'a\0b@example.com',
    'a@exam\x7fple.com',
    'a\tb@example.com',
    'a b@example.com',
    'a@example.com>',
    '<a@example.com',
    '@example.com',
    'a@',
  ])('refuses the address %j before opening the dialogue', async (to) => {
    const server = new StandIn(HAPPY);
    await expect(sendSmtp(server, login, { ...mail, to }, now)).rejects.toThrow(new SmtpError('input', 'to is not a plain address'));
    expect(server.sent).toEqual([]);
  });

  // Credentials never cross an unencrypted connection.
  it('refuses a server that does not offer STARTTLS, before sending AUTH', async () => {
    const server = new StandIn({ ...HAPPY, 'EHLO shyden.co.uk': '250-mail.example\r\n250 AUTH PLAIN' });
    await expect(sendSmtp(server, login, mail, now)).rejects.toThrow(new SmtpError('ehlo', 'server does not offer STARTTLS'));
    expect(server.sent).toEqual(['EHLO shyden.co.uk']);
    expect(server.closed).toBe(true);
  });

  it('refuses a server that does not offer AUTH PLAIN after TLS', async () => {
    const server = new StandIn({ ...HAPPY, 'EHLO shyden.co.uk (tls)': '250-mail.example\r\n250 AUTH LOGIN' });
    await expect(sendSmtp(server, login, mail, now)).rejects.toThrow(new SmtpError('ehlo', 'server does not offer AUTH PLAIN'));
    expect(server.sent.some((line) => line.startsWith('AUTH'))).toBe(false);
  });

  it.each([
    ['greeting', 'greeting', '554 go away'],
    ['ehlo', 'EHLO shyden.co.uk', '500 what'],
    ['starttls', 'STARTTLS', '454 TLS not available'],
    ['ehlo', 'EHLO shyden.co.uk (tls)', '421 closing'],
    ['auth', 'AUTH', '535 Incorrect authentication data'],
    ['mail-from', 'MAIL FROM', '550 sender rejected'],
    ['rcpt-to', 'RCPT TO', '550 no such user'],
    ['data', 'DATA', '451 try later'],
    ['message', '.', '552 too big'],
  ])('throws naming the %s step and the server reply when %s answers %s, and closes', async (step, key, reply) => {
    const server = new StandIn({ ...HAPPY, [key]: reply });
    await expect(sendSmtp(server, login, mail, now)).rejects.toThrow(new SmtpError(step, reply));
    expect(server.closed).toBe(true);
  });

  // The message is already accepted once the dot is answered 250.
  it('treats a QUIT that is not answered 221 as sent', async () => {
    const server = new StandIn({ ...HAPPY, QUIT: '500 odd' });
    await expect(sendSmtp(server, login, mail, now)).resolves.toBeUndefined();
    expect(server.closed).toBe(true);
  });

  // shyden-labs/shydesk#226: nothing after the 250 to the dot can unsend the mail.
  it('treats a QUIT that cannot be written as sent, and still closes', async () => {
    const server = new Failing(HAPPY, 'quit-write');
    await expect(sendSmtp(server, login, mail, now)).resolves.toBeUndefined();
    expect(server.closed).toBe(true);
  });

  it('treats a QUIT whose reply cannot be read as sent, and still closes', async () => {
    const server = new Failing(HAPPY, 'quit-read');
    await expect(sendSmtp(server, login, mail, now)).resolves.toBeUndefined();
    expect(server.closed).toBe(true);
  });

  it('treats a close that fails after the message was accepted as sent', async () => {
    const server = new Failing(HAPPY, 'close');
    await expect(sendSmtp(server, login, mail, now)).resolves.toBeUndefined();
  });

  it('still throws the step that failed when close also fails', async () => {
    const server = new Failing({ ...HAPPY, AUTH: '535 no' }, 'close');
    await expect(sendSmtp(server, login, mail, now)).rejects.toThrow(new SmtpError('auth', '535 no'));
  });

  it('accepts 251 for a forwarded recipient', async () => {
    const server = new StandIn({ ...HAPPY, 'RCPT TO': '251 User not local; will forward' });
    await expect(sendSmtp(server, login, mail, now)).resolves.toBeUndefined();
  });

  it('names the step and the last reply line of a multi-line refusal', async () => {
    const server = new StandIn({ ...HAPPY, AUTH: '535-first line\r\n535 Incorrect authentication data' });
    await expect(sendSmtp(server, login, mail, now)).rejects.toThrow(new SmtpError('auth', '535 Incorrect authentication data'));
  });
});

// On Workers, startTls() returns a new socket and the plain one is spent.
class Upgrading extends StandIn {
  secure: StandIn | undefined;
  private readonly tlsScript: Script;

  constructor(script: Script) {
    super(script);
    this.tlsScript = script;
  }

  override startTls(): Promise<SmtpConnection> {
    this.secure = new StandIn(this.tlsScript, true);
    return Promise.resolve(this.secure);
  }
}

// A connection that ends without a reply line at all.
class Silent extends StandIn {
  override readReply(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

describe('sendSmtp after the TLS upgrade', () => {
  it('sends the rest of the dialogue on the upgraded connection and closes it', async () => {
    const server = new Upgrading(HAPPY);
    await sendSmtp(server, login, mail, now);
    expect(server.sent).toEqual(['EHLO shyden.co.uk', 'STARTTLS']);
    expect(server.secure?.sent[0]).toBe('EHLO shyden.co.uk');
    expect(server.secure?.closed).toBe(true);
  });

  it('closes the upgraded connection when a later step fails', async () => {
    const server = new Upgrading({ ...HAPPY, AUTH: '535 no' });
    await expect(sendSmtp(server, login, mail, now)).rejects.toThrow(new SmtpError('auth', '535 no'));
    expect(server.secure?.closed).toBe(true);
  });
});

describe('sendSmtp with no reply', () => {
  it('throws naming the greeting step when the server sends no reply line', async () => {
    const server = new Silent(HAPPY);
    await expect(sendSmtp(server, login, mail, now)).rejects.toThrow(new SmtpError('greeting', '(no reply)'));
    expect(server.closed).toBe(true);
  });
});

describe('SmtpError', () => {
  it('carries the step and reply in its message and fields', () => {
    const error = new SmtpError('auth', '535 no');
    expect([error.name, error.step, error.reply, error.message]).toEqual(['SmtpError', 'auth', '535 no', 'SMTP auth failed: 535 no']);
  });
});
