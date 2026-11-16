import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import type { PunishmentRow } from '../../src/db/types.ts';
import { CALLBACK_TIMEOUT_MS, send, type CallbackTarget, type Fetcher } from '../../src/punishments/send.ts';
import { verify } from '../../src/punishments/sign.ts';
import { standInDb, type Statement } from './d1-stand-in.ts';

// Sending a punishment to the product (shyden-labs/shydesk#60 AC2). One signed POST,
// aborted after 10 s, recorded as `applied` only on a 200 with `applied: true`.
// Anything else is `failed` with the reason. ShyDesk never sends twice by itself.

const NOW = 1_762_500_000_123;
const TARGET: CallbackTarget = { id: 'shytalk', callbackUrl: 'https://api.shytalk.example/punish', callbackSecret: 'the-secret' };
const PUN: PunishmentRow = {
  id: 'pun-1',
  product_id: 'shytalk',
  report_ticket_id: 'r1',
  subject_user_id: 'user-2',
  punishment_key: 'ban-7d',
  label: 'Ban 7 days',
  duration_seconds: 604800,
  applied_by: 'rep@example.com',
  created_at: 1_762_499_000_000,
  send_state: 'sending',
  send_error: null,
  appeal_token_hash: 'h',
  lifted_at: null,
  lifted_by: null,
  lift_state: null,
  lift_error: null,
};
const APPEAL = 'https://shytalk.example/appeal#appeal=tok';

interface Call {
  url: string;
  init: RequestInit;
}

function fetcherAnswering(answer: () => Promise<Response>): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetcher, calls };
}

const recorded = (statements: Statement[]) => statements.filter((s) => /^UPDATE punishments SET/.test(s.sql));

afterEach(() => {
  vi.useRealTimers();
});

describe('send', () => {
  it('posts once to the callback with a body the product can verify with the shared code', async () => {
    const { db } = standInDb();
    const { fetcher, calls } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: true })));
    await send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(TARGET.callbackUrl);
    expect(call?.init.method).toBe('POST');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    const timestamp = Number(headers.get('ShyDesk-Timestamp'));
    expect(timestamp).toBe(Math.floor(NOW / 1000));
    const raw = call?.init.body as string;
    await expect(verify('the-secret', timestamp, raw, headers.get('ShyDesk-Signature') ?? '', timestamp)).resolves.toBe(true);
    expect(JSON.parse(raw)).toEqual({
      type: 'punishment.apply',
      punishment_id: 'pun-1',
      product: 'shytalk',
      subject_user_id: 'user-2',
      punishment: { key: 'ban-7d', label: 'Ban 7 days', duration_seconds: 604800 },
      report_ticket_id: 'r1',
      appeal_url: APPEAL,
      issued_at: PUN.created_at,
    });
  });

  it('sends a body that matches the webhook schema in the OpenAPI spec', async () => {
    const spec = parse(readFileSync(new URL('../../openapi/shydesk.v1.yaml', import.meta.url), 'utf8')) as {
      webhooks: Record<string, { post: { requestBody: { content: { 'application/json': { schema: { $ref: string } } } } } }>;
      components: { schemas: Record<string, object> };
    };
    const ref = spec.webhooks.punishment?.post.requestBody.content['application/json'].schema.$ref ?? '';
    const name = ref.replace('#/components/schemas/', '');
    const validate = new Ajv2020({ strict: true }).compile(spec.components.schemas[name] ?? {});
    const { db } = standInDb();
    const bodies: unknown[] = [];
    for (const [type, appeal] of [
      ['punishment.apply', APPEAL],
      ['punishment.lift', null],
    ] as const) {
      const { fetcher, calls } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: true })));
      await send(db, TARGET, { ...PUN, duration_seconds: null }, type, appeal, fetcher, NOW);
      bodies.push(JSON.parse(calls[0]?.init.body as string));
    }
    for (const body of bodies) expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  });

  it('records applied on a 200 with applied: true', async () => {
    const { db, statements } = standInDb();
    const { fetcher } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: true, note: 'ok' })));
    await expect(send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW)).resolves.toBe('applied');
    expect(recorded(statements)[0]?.sql).toMatch(/UPDATE punishments SET send_state = \?, send_error = \? WHERE id = \?/);
    expect(recorded(statements)[0]?.values).toEqual(['applied', null, 'pun-1']);
  });

  it('records not_applied on a 200 with applied: false, calling once', async () => {
    const { db, statements } = standInDb();
    const { fetcher, calls } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: false })));
    await expect(send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW)).resolves.toBe('failed');
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'not_applied', 'pun-1']);
    expect(calls).toHaveLength(1);
  });

  it('records not_applied on a 200 that is not JSON', async () => {
    const { db, statements } = standInDb();
    const { fetcher } = fetcherAnswering(() => Promise.resolve(new Response('ok')));
    await send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW);
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'not_applied', 'pun-1']);
  });

  it('records http_500 user_gone on a 500 with {"error":"user_gone"}, calling once', async () => {
    const { db, statements } = standInDb();
    const { fetcher, calls } = fetcherAnswering(() => Promise.resolve(Response.json({ error: 'user_gone' }, { status: 500 })));
    await expect(send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW)).resolves.toBe('failed');
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'http_500 user_gone', 'pun-1']);
    expect(calls).toHaveLength(1);
  });

  it('records http_201 for a 201, since only a 200 counts as applied', async () => {
    const { db, statements } = standInDb();
    const { fetcher } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: true }, { status: 201 })));
    await expect(send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW)).resolves.toBe('failed');
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'http_201', 'pun-1']);
  });

  it('records not_applied for a 200 that does not say applied: true', async () => {
    for (const body of [{}, { applied: 'yes' }, { applied: 1 }]) {
      const { db, statements } = standInDb();
      const { fetcher } = fetcherAnswering(() => Promise.resolve(Response.json(body)));
      await expect(send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW)).resolves.toBe('failed');
      expect(recorded(statements)[0]?.values).toEqual(['failed', 'not_applied', 'pun-1']);
    }
  });

  it('never puts an appeal link on a lift, even when one is passed', async () => {
    const { db } = standInDb();
    const { fetcher, calls } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: true })));
    await send(db, TARGET, PUN, 'punishment.lift', APPEAL, fetcher, NOW);
    expect(JSON.parse(calls[0]?.init.body as string)).not.toHaveProperty('appeal_url');
  });

  it('records the status alone when the error code is not text', async () => {
    const { db, statements } = standInDb();
    const { fetcher } = fetcherAnswering(() => Promise.resolve(Response.json({ error: 5 }, { status: 500 })));
    await send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW);
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'http_500', 'pun-1']);
  });

  it('records the status alone when the answer names no error code', async () => {
    const { db, statements } = standInDb();
    const { fetcher } = fetcherAnswering(() => Promise.resolve(new Response('Not Found', { status: 404 })));
    await send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW);
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'http_404', 'pun-1']);
  });

  it('records timeout after the 10 s abort when the product never answers, calling once', async () => {
    // Only the timers are faked: signing runs first on real promises, so the clock
    // moves once the request has been made.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { db, statements } = standInDb();
    const { fetcher, calls } = fetcherAnswering(() => new Promise<Response>(() => undefined));
    let done: string | undefined;
    const sending = send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW).then((state) => {
      done = state;
      return state;
    });
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(CALLBACK_TIMEOUT_MS - 1);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(sending).resolves.toBe('failed');
    expect(CALLBACK_TIMEOUT_MS).toBe(10_000);
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'timeout', 'pun-1']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });

  it('records network_error when the request cannot be made, calling once', async () => {
    const { db, statements } = standInDb();
    const { fetcher, calls } = fetcherAnswering(() => Promise.reject(new TypeError('fetch failed')));
    await expect(send(db, TARGET, PUN, 'punishment.apply', APPEAL, fetcher, NOW)).resolves.toBe('failed');
    expect(recorded(statements)[0]?.values).toEqual(['failed', 'network_error', 'pun-1']);
    expect(calls).toHaveLength(1);
  });

  it('records no_callback, calling nothing, when the product has no callback or no secret', async () => {
    for (const target of [
      { ...TARGET, callbackUrl: null },
      { ...TARGET, callbackSecret: null },
    ]) {
      const { db, statements } = standInDb();
      const { fetcher, calls } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: true })));
      await expect(send(db, target, PUN, 'punishment.apply', APPEAL, fetcher, NOW)).resolves.toBe('failed');
      expect(recorded(statements)[0]?.values).toEqual(['failed', 'no_callback', 'pun-1']);
      expect(calls).toEqual([]);
    }
  });

  it('records a lift in the lift columns and sends no appeal link', async () => {
    const { db, statements } = standInDb();
    const { fetcher, calls } = fetcherAnswering(() => Promise.resolve(Response.json({ applied: true })));
    await expect(send(db, TARGET, PUN, 'punishment.lift', null, fetcher, NOW)).resolves.toBe('applied');
    expect(recorded(statements)[0]?.sql).toMatch(/UPDATE punishments SET lift_state = \?, lift_error = \? WHERE id = \?/);
    expect(recorded(statements)[0]?.values).toEqual(['applied', null, 'pun-1']);
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body.type).toBe('punishment.lift');
    expect(body).not.toHaveProperty('appeal_url');
  });
});
