import type { D1Database } from '@cloudflare/workers-types';
import { readBounce } from './bounce-report.ts';

/**
 * Records a failed delivery report on the notice it is about (shyden-labs/shydesk#232). Each notice is sent
 * from bounce-<notice id>@BOUNCE_DOMAIN, so Email Routing hands its failure report here. Anything that is not
 * a failed report to a notice still waiting for one is rejected and nothing is written; only the first report
 * for a notice counts.
 */

/** The part of Email Routing's message this reads. */
export interface BounceMessage {
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface BounceEnv {
  DB: D1Database;
  BOUNCE_DOMAIN?: string | undefined;
}

/** Reports are a few kilobytes; anything far larger is not read. */
const MOST_BYTES = 1_000_000;

const RECORD = 'UPDATE notices SET bounced_at = ?, bounce_status = ?, bounce_reason = ? WHERE id = ? AND bounced_at IS NULL';

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export async function handleBounce(message: BounceMessage, env: BounceEnv, now = Date.now()): Promise<void> {
  const domain = env.BOUNCE_DOMAIN;
  const match = domain === undefined ? null : new RegExp(`^bounce-([0-9a-f-]{36})@${escaped(domain)}$`, 'i').exec(message.to);
  const id = match?.[1]?.toLowerCase();
  if (id === undefined) {
    message.setReject('unknown notice');
    return;
  }
  if (message.rawSize > MOST_BYTES) {
    message.setReject('too large');
    return;
  }
  const bounce = readBounce(await new Response(message.raw).text());
  if (bounce === null) {
    message.setReject('not a failed delivery report');
    return;
  }
  const result = await env.DB.prepare(RECORD).bind(now, bounce.status, bounce.reason, id).run();
  if (result.meta.changes === 0) message.setReject('unknown notice');
}
