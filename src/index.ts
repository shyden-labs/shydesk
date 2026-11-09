import { Hono } from 'hono';
import { adminRoutes } from './admin/routes.ts';
import { docsRoutes, type DocsEnv } from './api/docs.ts';
import { apiRoutes } from './api/routes.ts';
import { contactRoutes, type ContactBindings } from './customer/contact.ts';
import { embedRoutes, type EmbedEnv } from './customer/embed.ts';
import { ticketRoutes } from './customer/ticket.ts';
import type { Deliver } from './mail/notify.ts';
import { uploadRoutes, type UploadBindings } from './uploads/routes.ts';

// The Durable Object classes wrangler.jsonc binds must be exported from the entry point.
export { TicketTimer } from './timers/ticket-timer.ts';

/**
 * ShyDesk's single Worker (shyden-labs/shydesk#14). Staff routes need the
 * Access settings and FIRST_ADMIN_EMAIL: without the Access settings they
 * answer 401 to everyone; with them but no FIRST_ADMIN_EMAIL, a signed-in
 * person gets 503 naming it (shyden-labs/shydesk#81).
 */
export const app = new Hono<{ Bindings: DocsEnv & ContactBindings & EmbedEnv & UploadBindings }>();

/**
 * Mail delivery for the Worker. Nothing opens an SMTP connection yet
 * (shyden-labs/shydesk#68), so each send fails by name: the customer is told
 * the email could not be sent and to keep the private link.
 */
export const noSmtpYet: Deliver = () => Promise.reject(new Error('the Worker has no SMTP connection yet (shyden-labs/shydesk#68)'));

// What a deploy is read back with: answers without touching any binding.
app.get('/health', (c) => c.json({ ok: true }));

app.route('/', adminRoutes());
app.route('/', apiRoutes());
app.route('/', docsRoutes());
// Before contact: its origin check covers all of /support-api, and this answers first with its own.
app.route('/', uploadRoutes());
app.route('/', ticketRoutes());
app.route('/', contactRoutes({ fetcher: fetch.bind(globalThis), deliver: noSmtpYet }));
app.route('/', embedRoutes());

export default app;
