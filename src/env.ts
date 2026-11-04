import type { D1Database } from '@cloudflare/workers-types';

/**
 * The Worker's bindings, one field per binding in wrangler.jsonc. Each later
 * task adds the binding it uses (R2 for uploads once shyden-labs/shydesk#35
 * enables R2, the ticket timer, Access, Turnstile and mail settings), so this
 * type never claims a binding the deploy does not have.
 */
export interface Env {
  DB: D1Database;
}
