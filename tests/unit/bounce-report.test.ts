import { describe, expect, it } from 'vitest';
import { readBounce } from '../../src/mail/bounce-report.ts';

// Failed delivery reports (RFC 3464) read into the status and reason the desk shows (shyden-labs/shydesk#232).
// Only multipart/report; report-type=delivery-status with Action: failed counts.

const report = (o: { top?: string; status?: string; action?: string; diagnostic?: string; perRecipient?: string; eol?: string } = {}) =>
  [
    'From: Mail Delivery System <MAILER-DAEMON@relay.example>',
    'To: bounce-0b9f1c2e-1111-4222-8333-944455556666@bounce.example',
    'Subject: Undelivered Mail Returned to Sender',
    'MIME-Version: 1.0',
    o.top ?? 'Content-Type: multipart/report; report-type=delivery-status;\r\n\tboundary="B0UND"',
    '',
    'This is a MIME-encapsulated message.',
    '',
    '--B0UND',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'Your message could not be delivered.',
    '',
    '--B0UND',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; relay.example',
    'Arrival-Date: Fri, 20 Nov 2026 16:40:01 +0000',
    '',
    o.perRecipient ??
      [
        'Final-Recipient: rfc822; no-such-user@gmail.com',
        `Action: ${o.action ?? 'failed'}`,
        `Status: ${o.status ?? '5.1.1'}`,
        'Remote-MTA: dns; gmail-smtp-in.l.google.com',
        `Diagnostic-Code: ${o.diagnostic ?? 'smtp; 550 5.1.1 The email account that you tried to reach does not exist.'}`,
      ].join('\r\n'),
    '',
    '--B0UND',
    'Content-Type: text/rfc822-headers',
    '',
    'From: shydesk-no-reply@shyden.co.uk',
    '',
    '--B0UND--',
    '',
  ]
    .join('\r\n')
    .replaceAll('\r\n', o.eol ?? '\r\n');

describe('readBounce', () => {
  it('reads the status and the server reason, without its smtp; type', () => {
    expect(readBounce(report())).toEqual({
      status: '5.1.1',
      reason: '550 5.1.1 The email account that you tried to reach does not exist.',
    });
  });

  it('reads a report written with bare LF line ends', () => {
    expect(readBounce(report({ eol: '\n' }))?.status).toBe('5.1.1');
  });

  it('reads a top Content-Type with an unquoted boundary and upper-case names', () => {
    const top = 'CONTENT-TYPE: Multipart/Report; Report-Type=Delivery-Status; Boundary=B0UND';
    expect(readBounce(report({ top }))?.status).toBe('5.1.1');
  });

  it('keeps a reason that names no type as it is', () => {
    expect(readBounce(report({ diagnostic: '550 no such user' }))?.reason).toBe('550 no such user');
  });

  it('unfolds a Diagnostic-Code folded over several lines into one', () => {
    const diagnostic =
      'smtp; 550-5.1.1 The email account that you tried to reach\r\n    does not exist. Please try\r\n\tdouble-checking the address.';
    expect(readBounce(report({ diagnostic }))?.reason).toBe(
      '550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking the address.',
    );
  });

  it('cuts the status and the reason to 500 characters', () => {
    const read = readBounce(report({ status: `5.${'1'.repeat(600)}`, diagnostic: `smtp; ${'x'.repeat(600)}` }));
    expect(read?.status).toHaveLength(500);
    expect(read?.reason).toBe('x'.repeat(500));
  });

  it('gives an empty reason when the report has no Diagnostic-Code', () => {
    const perRecipient = 'Final-Recipient: rfc822; a@b.example\r\nAction: failed\r\nStatus: 5.0.0';
    expect(readBounce(report({ perRecipient }))).toEqual({ status: '5.0.0', reason: '' });
  });

  it('gives an empty status when the failed block names none', () => {
    const perRecipient = 'Final-Recipient: rfc822; a@b.example\r\nAction: failed\r\nDiagnostic-Code: smtp; 550 gone';
    expect(readBounce(report({ perRecipient }))).toEqual({ status: '', reason: '550 gone' });
  });

  it('reads the failed recipient when another one was only delayed', () => {
    const perRecipient = [
      'Final-Recipient: rfc822; slow@b.example',
      'Action: delayed',
      'Status: 4.4.1',
      '',
      'Final-Recipient: rfc822; gone@b.example',
      'Action: Failed',
      'Status: 5.1.2',
      'Diagnostic-Code: smtp; 550 5.1.2 bad domain',
    ].join('\r\n');
    expect(readBounce(report({ perRecipient }))).toEqual({ status: '5.1.2', reason: '550 5.1.2 bad domain' });
  });

  it.each([
    ['an auto-reply (text/plain)', 'Content-Type: text/plain; charset=utf-8'],
    ['a report of another type', 'Content-Type: multipart/report; report-type=disposition-notification; boundary="B0UND"'],
    ['a multipart message that is not a report', 'Content-Type: multipart/mixed; boundary="B0UND"'],
    ['a report with no boundary', 'Content-Type: multipart/report; report-type=delivery-status'],
  ])('gives null for %s', (_what, top) => {
    expect(readBounce(report({ top }))).toBeNull();
  });

  it('gives null for a report whose recipients were only delayed', () => {
    expect(readBounce(report({ action: 'delayed', status: '4.4.7' }))).toBeNull();
  });

  it('gives null for a report with no delivery-status part', () => {
    expect(readBounce(report().replace('Content-Type: message/delivery-status', 'Content-Type: text/plain'))).toBeNull();
  });

  it('gives null for a message with no headers end or no Content-Type', () => {
    expect(readBounce('just one line')).toBeNull();
    expect(readBounce('Subject: hi\r\n\r\nbody')).toBeNull();
  });
});
