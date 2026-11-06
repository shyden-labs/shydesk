import { Hono } from 'hono';
import { adminRoutes } from './admin/routes.ts';
import type { StaffEnv } from './auth/staff.ts';

/**
 * ShyDesk's single Worker (shyden-labs/shydesk#14). Staff routes need the
 * Access settings and FIRST_ADMIN_EMAIL; on a deploy without them (until
 * shyden-labs/shydesk#13 sets Access up) they answer 401 to everyone.
 */
export const app = new Hono<{ Bindings: StaffEnv }>();

// What a deploy is read back with: answers without touching any binding.
app.get('/health', (c) => c.json({ ok: true }));

app.route('/', adminRoutes());

export default app;
