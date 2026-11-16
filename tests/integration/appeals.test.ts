// Appeals on a real D1 database (shyden-labs/shydesk#61; Release 2 plan Task 5).
// One journey with every check: the appeal row's primary key refuses a second
// appeal for the same punishment, with the message createAppeal turns into
// already_appealed; a rejected appeal takes no other, a lifted punishment none;
// upheld sends one punishment.lift. And the desk's SQL leaves appeals out for a
// rep (list, lookup, files and the unread count) while the admin sees them.
// This harness runs a batch one statement at a time, so the rollback of a refused
// appeal's ticket is D1's own batch transaction and is not what is checked here.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { AppealRefused, appealStatus, createAppeal, decideAppeal, findAppealable } from '../../src/appeals/appeals.ts';
import type { Staff } from '../../src/auth/staff.ts';
import { getFile, getTicket, listTickets, unreadCount } from '../../src/desk/queries.ts';
import { saveCallback, saveProduct, savePunishments, saveReportReasons } from '../../src/products.ts';
import { appealToken, applyPunishment, liftPunishment } from '../../src/punishments/apply.ts';
import type { Fetcher } from '../../src/punishments/send.ts';
import { createReport } from '../../src/reports/create.ts';
import { query, restD1 } from './d1.ts';

const id = inject('databaseId');
const db = restD1(id);
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const env = { DB: db, TICKET_TOKEN_KEY: KEY };
const REP: Staff = { email: 'appeals-rep@example.com', role: 'rep', products: ['it-app'] };
const ADMIN: Staff = { email: 'appeals-admin@example.com', role: 'admin', products: ['it-app'] };
const INPUT = { email: 'appellant@example.com', message: 'Please look again.' };

const sent: string[] = [];
const fetcher: Fetcher = (_url, init) => {
  sent.push((JSON.parse(init.body as string) as { type: string }).type);
  return Promise.resolve(Response.json({ applied: true }));
};

let reportId = '';
const punishmentIds: string[] = [];

const rows = async (sql: string, values: unknown[]) => (await query(id, sql, values))[0]?.results ?? [];

/** The punishment as an appeal sees it; it must exist. */
async function appealable(by: { token: string } | { punishmentId: string }) {
  const found = await findAppealable(db, 'it-app', by);
  if (found === null) throw new Error(`no punishment for ${JSON.stringify(by)}`);
  return found;
}

// About 2 s per call over D1's REST API, so the setup happens once, here.
beforeAll(async () => {
  await saveProduct(
    db,
    {
      id: 'it-app',
      name: 'Product it-app',
      senderAddress: 'no-reply@it-app.example',
      ticketPageUrl: 'https://it-app.example/ticket',
      allowedOrigins: ['https://it-app.example'],
      monthlyEmailShare: 100,
      attachmentsKeepDays: 30,
      textKeepDays: 365,
    },
    1000,
  );
  await saveReportReasons(db, 'it-app', ['Cheating']);
  await savePunishments(db, 'it-app', [{ key: 'ban-7d', label: 'Ban 7 days', duration_seconds: 604800 }]);
  await saveCallback(db, 'it-app', 'https://api.it-app.example/punish', 'https://it-app.example/appeal');
  reportId = await createReport(db, 'it-app', {
    reporter_id: 'reporter-1',
    item: { kind: 'player', id: 'subject-1' },
    subject_user_id: 'subject-1',
    reason: 'Cheating',
    note: '',
    context: {},
    upload_ids: [],
  });
  for (let i = 0; i < 3; i++) punishmentIds.push((await applyPunishment(env, ADMIN, reportId, 'ban-7d', fetcher)).id);
});

describe('appeals', () => {
  it('takes one appeal per punishment, none after a rejection or a lift, and upheld sends one lift', async () => {
    const [rejected, lifted, upheld] = punishmentIds as [string, string, string];

    // The ban notice link's token opens its punishment, and only within the product.
    const byToken = await appealable({ token: await appealToken(KEY, rejected) });
    expect.soft(byToken.id).toBe(rejected);
    expect.soft(appealStatus(byToken)).toMatchObject({ can_appeal: true, label: 'Ban 7 days' });
    expect.soft(await findAppealable(db, 'other-product', { token: await appealToken(KEY, rejected) })).toBeNull();

    // The same link used twice: one appeal, then already_appealed.
    const first = await createAppeal(db, byToken, INPUT, KEY);
    const second = await createAppeal(db, byToken, INPUT, KEY).catch((e: unknown) => e);
    expect.soft(second).toBeInstanceOf(AppealRefused);
    expect.soft((second as AppealRefused).code).toBe('already_appealed');
    expect
      .soft(await rows('SELECT ticket_id, state FROM appeals WHERE punishment_id = ?', [rejected]))
      .toEqual([{ ticket_id: first.id, state: 'open' }]);
    expect.soft(await rows('SELECT kind FROM ticket_types WHERE id = ?', ['it-app:appeal'])).toEqual([{ kind: 'appeal' }]);

    // Rejected: recorded, nothing sent, and a further appeal is already_appealed.
    sent.length = 0;
    expect.soft(await decideAppeal(env, ADMIN, first.id, 'rejected', fetcher)).toBe('rejected');
    const afterReject = await appealable({ punishmentId: rejected });
    expect.soft(appealStatus(afterReject)).toMatchObject({ can_appeal: false, reason: 'already_appealed' });
    expect.soft(await createAppeal(db, afterReject, INPUT, KEY).catch((e: unknown) => (e as AppealRefused).code)).toBe('already_appealed');
    expect
      .soft(await rows('SELECT state, decided_by FROM appeals WHERE punishment_id = ?', [rejected]))
      .toEqual([{ state: 'rejected', decided_by: ADMIN.email }]);

    // A lifted punishment: lifted.
    await liftPunishment(env, ADMIN, lifted, fetcher);
    const afterLift = await appealable({ punishmentId: lifted });
    expect.soft(await createAppeal(db, afterLift, INPUT, KEY).catch((e: unknown) => (e as AppealRefused).code)).toBe('lifted');

    // Upheld: exactly one punishment.lift, and the punishment is lifted.
    const appeal = await createAppeal(db, await appealable({ punishmentId: upheld }), INPUT, KEY);
    sent.length = 0;
    expect.soft(await decideAppeal(env, ADMIN, appeal.id, 'upheld', fetcher)).toBe('applied');
    expect.soft(sent).toEqual(['punishment.lift']);
    expect
      .soft(await rows('SELECT lifted_by, lift_state FROM punishments WHERE id = ?', [upheld]))
      .toEqual([{ lifted_by: ADMIN.email, lift_state: 'applied' }]);
    // A second decision is refused and sends nothing.
    expect
      .soft(await decideAppeal(env, ADMIN, appeal.id, 'rejected', fetcher).catch((e: unknown) => (e as AppealRefused).code))
      .toBe('already_decided');
    expect.soft(sent).toEqual(['punishment.lift']);
    // A rep cannot decide one at all.
    expect
      .soft(await decideAppeal(env, REP, appeal.id, 'rejected', fetcher).catch((e: unknown) => (e as Error).name))
      .toBe('AppealNotFound');
  });

  it("leaves appeals out of a rep's list, lookup, files and unread count, and keeps them in the admin's", async () => {
    const repUnreadBefore = await unreadCount(db, REP.email, REP);
    const adminUnreadBefore = await unreadCount(db, ADMIN.email, ADMIN);
    // Every punishment above was appealed already, so this check makes its own.
    const fresh = (await applyPunishment(env, ADMIN, reportId, 'ban-7d', fetcher)).id;
    const made = await createAppeal(db, await appealable({ punishmentId: fresh }), INPUT, KEY);
    await query(
      id,
      `INSERT INTO attachments (id, product_id, ticket_id, message_id, r2_key, mime, bytes, state, created_at)
       VALUES (?, 'it-app', ?, (SELECT id FROM messages WHERE ticket_id = ?), 'key-appeal-file', 'image/jpeg', 10, 'stored', 1)`,
      ['it-app-appeal-file', made.id, made.id],
    );

    const repList = (await listTickets(db, REP, {})).map((t) => t.id);
    const adminList = (await listTickets(db, ADMIN, {})).map((t) => t.id);
    expect.soft(repList).toContain(reportId);
    expect.soft(repList).not.toContain(made.id);
    expect.soft(adminList).toContain(made.id);
    expect.soft(await getTicket(db, REP, made.id)).toBeNull();
    expect.soft((await getTicket(db, ADMIN, made.id))?.ticket.id).toBe(made.id);
    expect.soft(await getTicket(db, REP, reportId)).not.toBeNull();
    expect.soft(await getFile(db, REP, 'it-app-appeal-file')).toBeNull();
    expect.soft((await getFile(db, ADMIN, 'it-app-appeal-file'))?.r2_key).toBe('key-appeal-file');
    expect.soft(await unreadCount(db, REP.email, REP)).toBe(repUnreadBefore);
    expect.soft(await unreadCount(db, ADMIN.email, ADMIN)).toBe(adminUnreadBefore + 1);
  });
});
