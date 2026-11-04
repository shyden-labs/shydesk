import { Hono } from 'hono';
import type { Env } from './env.ts';

/** ShyDesk's single Worker (shyden-labs/shydesk#14). */
export const app = new Hono<{ Bindings: Env }>();

// What a deploy is read back with: answers without touching any binding.
app.get('/health', (c) => c.json({ ok: true }));

export default app;
