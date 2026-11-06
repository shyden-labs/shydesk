import { DurableObject } from 'cloudflare:workers';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { timerPlan, writeStatus, type Kind, type TimerPlan } from '../tickets/status.ts';
import { deleteAttachments, deleteText } from './retention.ts';

/**
 * One ticket's timer (shyden-labs/shydesk#22), a Durable Object named by the
 * ticket id: it keeps each kind's due time in its storage and one alarm at the
 * earliest, so expiry runs at its exact time with no scheduled job, and an idle
 * ShyDesk costs nothing. When the alarm fires it re-reads the ticket, so a
 * timer for a ticket that changed in between does nothing.
 *
 * A failure is logged and not retried: the item stays stored past its due date
 * and the admin desk's overdue panel (src/desk/overdue.ts) shows it, to be fixed
 * by its cause.
 */

export interface TicketTimerEnv {
  DB: D1Database;
  /** Bound once R2 is enabled (shyden-labs/shydesk#35, shyden-labs/shydesk#20); until then no attachment can be stored. */
  FILES?: R2Bucket;
}

const KINDS: Kind[] = ['autoclose', 'attachments', 'text'];
const due = (kind: Kind): string => `due:${kind}`;

export class TicketTimer extends DurableObject<TicketTimerEnv> {
  private get storage() {
    return this.ctx.storage;
  }

  /** Applies a status change's plan to this ticket's timer. */
  async apply(ticketId: string, plan: TimerPlan): Promise<void> {
    await this.storage.put('ticket', ticketId);
    await this.write(plan);
  }

  override async alarm(): Promise<void> {
    const ticketId = await this.storage.get<string>('ticket');
    if (ticketId === undefined) return;
    const now = Date.now();
    for (const kind of KINDS) {
      const at = await this.storage.get<number>(due(kind));
      if (at === undefined || at > now) continue;
      await this.storage.delete(due(kind));
      try {
        await this.run(kind, ticketId, now);
      } catch (error) {
        console.error(`ticket ${ticketId}: ${kind} timer failed: ${(error as Error).message}`);
      }
    }
    await this.arm();
  }

  private async run(kind: Kind, ticketId: string, now: number): Promise<void> {
    switch (kind) {
      case 'autoclose': {
        const keep = await writeStatus(this.env.DB, ticketId, 'closed', now, 'waiting');
        if (keep !== null) await this.write(timerPlan('closed', keep, now));
        return;
      }
      case 'attachments':
        return deleteAttachments(this.env.DB, this.env.FILES, ticketId, now);
      case 'text':
        return deleteText(this.env.DB, this.env.FILES, ticketId, now);
    }
  }

  private async write(plan: TimerPlan): Promise<void> {
    for (const kind of plan.cancel) await this.storage.delete(due(kind));
    for (const [kind, at] of Object.entries(plan.schedule)) await this.storage.put(due(kind as Kind), at);
    await this.arm();
  }

  /** Sets the alarm to the earliest due time left, or removes it when none is. */
  private async arm(): Promise<void> {
    const left = [...(await this.storage.list<number>({ prefix: 'due:' })).values()];
    if (left.length === 0) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.min(...left));
  }
}
