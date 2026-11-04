/**
 * SMTP submission on port 587 (shyden-labs/shydesk#18): the no-reply mail
 * goes through Sparked Host. The connection is passed in, so the dialogue
 * runs the same against a Workers socket and a test stand-in.
 *
 * The dialogue refuses to log in unless the server offers STARTTLS and the
 * connection is upgraded first, and refuses any line break in a header value
 * or address, so input can never add a header or an SMTP command.
 */

/** One SMTP connection: whole replies in, CRLF-terminated text out. */
export interface SmtpConnection {
  /** The lines of the next complete reply, without their CRLFs. */
  readReply(): Promise<string[]>;
  write(text: string): Promise<void>;
  /** Upgrades to TLS and returns the connection to use from then on. */
  startTls(): Promise<SmtpConnection>;
  close(): Promise<void>;
}

export interface SmtpLogin {
  user: string;
  pass: string;
}

export interface SmtpMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export class SmtpError extends Error {
  readonly step: string;
  readonly reply: string;

  constructor(step: string, reply: string) {
    super(`SMTP ${step} failed: ${reply}`);
    this.name = 'SmtpError';
    this.step = step;
    this.reply = reply;
  }
}

const PLAIN_ADDRESS = /^[^\s<>@]+@[^\s<>@]+$/;
const ASCII = /^[\x20-\x7e]*$/;

function checkInput(mail: SmtpMail): void {
  for (const field of ['from', 'to', 'subject'] as const) {
    if (/[\r\n]/.test(mail[field])) throw new SmtpError('input', `${field} holds a line break`);
  }
  for (const field of ['from', 'to'] as const) {
    if (!PLAIN_ADDRESS.test(mail[field])) throw new SmtpError('input', `${field} is not a plain address`);
  }
}

const base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const encodedSubject = (subject: string): string => (ASCII.test(subject) ? subject : `=?UTF-8?B?${base64(subject)}?=`);

function message(mail: SmtpMail, now: Date): string {
  const domain = mail.from.slice(mail.from.indexOf('@') + 1);
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${encodedSubject(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  // RFC 5321 4.5.2: a line starting with a dot gets a second one.
  const body = mail.text.split(/\r?\n/).map((line) => (line.startsWith('.') ? `.${line}` : line));
  return [...headers, '', ...body, '.'].join('\r\n');
}

async function expectReply(connection: SmtpConnection, step: string, codes: string[]): Promise<string[]> {
  const lines = await connection.readReply();
  const last = lines.at(-1);
  if (last === undefined) throw new SmtpError(step, '(no reply)');
  if (!codes.includes(last.slice(0, 3))) throw new SmtpError(step, last);
  return lines;
}

async function command(connection: SmtpConnection, line: string, step: string, codes: string[]): Promise<string[]> {
  await connection.write(`${line}\r\n`);
  return expectReply(connection, step, codes);
}

const offers = (lines: string[], extension: RegExp): boolean => lines.some((line) => extension.test(line.slice(4)));

/** Runs the dialogue; `upgraded` hears the TLS connection the moment it exists, so it is the one closed. */
async function dialogue(
  plain: SmtpConnection,
  login: SmtpLogin,
  mail: SmtpMail,
  now: Date,
  upgraded: (secure: SmtpConnection) => void,
): Promise<void> {
  await expectReply(plain, 'greeting', ['220']);
  const greeting = await command(plain, 'EHLO shydesk', 'ehlo', ['250']);
  if (!offers(greeting, /^STARTTLS$/i)) throw new SmtpError('ehlo', 'server does not offer STARTTLS');
  await command(plain, 'STARTTLS', 'starttls', ['220']);
  const secure = await plain.startTls();
  upgraded(secure);
  const extensions = await command(secure, 'EHLO shydesk', 'ehlo', ['250']);
  if (!offers(extensions, /^AUTH\b.*\bPLAIN\b/i)) throw new SmtpError('ehlo', 'server does not offer AUTH PLAIN');
  await command(secure, `AUTH PLAIN ${base64(`\0${login.user}\0${login.pass}`)}`, 'auth', ['235']);
  await command(secure, `MAIL FROM:<${mail.from}>`, 'mail-from', ['250']);
  await command(secure, `RCPT TO:<${mail.to}>`, 'rcpt-to', ['250', '251']);
  await command(secure, 'DATA', 'data', ['354']);
  await command(secure, message(mail, now), 'message', ['250']);
}

/**
 * Sends one plain-text mail. Throws SmtpError naming the step and the
 * server's reply on anything unexpected, and always closes the connection.
 */
export async function sendSmtp(connection: SmtpConnection, login: SmtpLogin, mail: SmtpMail, now: Date): Promise<void> {
  let open = connection;
  try {
    checkInput(mail);
    await dialogue(connection, login, mail, now, (secure) => {
      open = secure;
    });
    // The message is accepted once the dot is answered 250; QUIT's reply changes nothing.
    await open.write('QUIT\r\n');
    await open.readReply();
  } finally {
    await open.close();
  }
}
