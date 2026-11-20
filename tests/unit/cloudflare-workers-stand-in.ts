// `cloudflare:workers` exists only inside the Workers runtime; the unit suite
// aliases it here (vitest.unit.config.ts). A Durable Object class is then a
// plain class holding the state and env it was made with, as the runtime's is.
export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
