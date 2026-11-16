// Punishments on a real D1 database (shyden-labs/shydesk#60; Release 2 plan Task 4).
// The product's side is stood in by a fetcher that checks every request with the
// shipped `verify` and the product's stored secret, as a product would, and answers
// `applied` only when the signature holds. The plan's dev-only echo route in the
// Worker was not built: the same check runs here, and nothing test-only ships.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import type { Staff } from '../../src/auth/staff.ts';
import { createApiKey, rotateSecret, saveCallback, saveProduct, savePunishments, saveReportReasons } from '../../src/products.ts';
import { applyPunishment, liftPunishment, resendPunishment } from '../../src/punishments/apply.ts';
import type { Fetcher } from '../../src/punishments/send.ts';
import { verify } from '../../src/punishments/sign.ts';
import { createReport } from '../../src/reports/create.ts';
import { offenderHistory } from '../../src/reports/history.ts';
import { query, restD1 } from './d1.ts';

const id = inject('databaseId');
const db = restD1(id);
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const env = { DB: db, TICKET_TOKEN_KEY: KEY };
const REP: Staff = { email: 'rep@example.com', role: 'rep', products: ['it-pun'] };
const ADMIN: Staff = { email: 'admin@example.com', role: 'admin', products: ['it-pun'] };

let secret = '';
let reportId = '';

/** The product's server: verifies the signature, then answers as told. */
function product(answer: 'applied' | 'refuse'): { fetcher: Fetcher; verified: boolean[]; ids: unknown[] } {
  const verified: boolean[] = [];
  const ids: unknown[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    const headers = new Headers(init.headers);
    const timestamp = Number(headers.get('ShyDesk-Timestamp'));
    const raw = init.body as string;
    const ok = await verify(secret, timestamp, raw, headers.get('ShyDesk-Signature') ?? '', Math.floor(Date.now() / 1000));
    verified.push(ok);
    ids.push((JSON.parse(raw) as { punishment_id: unknown }).punishment_id);
    if (!ok || answer === 'refuse') return Response.json({ error: ok ? 'user_gone' : 'bad_signature' }, { status: 500 });
    return Response.json({ applied: true });
  };
  return { fetcher, verified, ids };
}

const row = async (punishmentId: string) =>
  ((await query(id, 'SELECT send_state, send_error, lifted_at, lifted_by, lift_state FROM punishments WHERE id = ?', [punishmentId]))[0]
    ?.results ?? [])[0];

// About 2 s per setup call over D1's REST API, so all of it happens once, here.
beforeAll(async () => {
  await saveProduct(
    db,
    {
      id: 'it-pun',
      name: 'Product it-pun',
      senderAddress: 'no-reply@it-pun.example',
      ticketPageUrl: 'https://it-pun.example/ticket',
      allowedOrigins: ['https://it-pun.example'],
      monthlyEmailShare: 100,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    1000,
  );
  await saveReportReasons(db, 'it-pun', ['Cheating']);
  await savePunishments(db, 'it-pun', [{ key: 'ban-7d', label: 'Ban 7 days', duration_seconds: 604800 }]);
  await saveCallback(db, 'it-pun', 'https://api.it-pun.example/punish', 'https://it-pun.example/appeal');
  secret = await rotateSecret(db, 'it-pun');
  await createApiKey(db, 'it-pun', 'punishments test', 1000);
  reportId = await createReport(db, 'it-pun', {
    reporter_id: 'reporter-1',
    item: { kind: 'player', id: 'subject-1' },
    subject_user_id: 'subject-1',
    reason: 'Cheating',
    note: '',
    context: {},
    upload_ids: [],
  });
});

describe('punishments', () => {
  it('records applied when the product verifies the signature, and the history shows it', async () => {
    const side = product('applied');
    const applied = await applyPunishment(env, REP, reportId, 'ban-7d', side.fetcher);
    expect.soft(side.verified).toEqual([true]);
    expect.soft(await row(applied.id)).toMatchObject({ send_state: 'applied', send_error: null });
    const history = await offenderHistory(db, 'it-pun', 'subject-1');
    expect.soft(history.punishments.map((p) => [p.id, p.send_state])).toContainEqual([applied.id, 'applied']);
  });

  it('records a refusal as failed, then "Send again" sends the same id and records applied', async () => {
    const refusing = product('refuse');
    const failed = await applyPunishment(env, REP, reportId, 'ban-7d', refusing.fetcher);
    expect.soft(await row(failed.id)).toMatchObject({ send_state: 'failed', send_error: 'http_500 user_gone' });
    const accepting = product('applied');
    await resendPunishment(env, REP, failed.id, accepting.fetcher);
    expect.soft(accepting.ids).toEqual([failed.id]);
    expect.soft(await row(failed.id)).toMatchObject({ send_state: 'applied', send_error: null });
  });

  it('lets only the admin lift, once, recording who', async () => {
    const side = product('applied');
    const applied = await applyPunishment(env, REP, reportId, 'ban-7d', side.fetcher);
    await expect(liftPunishment(env, REP, applied.id, side.fetcher)).rejects.toThrow();
    await liftPunishment(env, ADMIN, applied.id, side.fetcher);
    expect.soft(await row(applied.id)).toMatchObject({ lifted_by: 'admin@example.com', lift_state: 'applied' });
    await expect(liftPunishment(env, ADMIN, applied.id, side.fetcher)).rejects.toMatchObject({ code: 'already_lifted' });
  });
});
