import { Hono } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import { adminRoutes } from './admin/routes.ts';
import { docsRoutes, type DocsEnv } from './api/docs.ts';
import { apiRoutes } from './api/routes.ts';
import { contactRoutes, type ContactBindings } from './customer/contact.ts';
import { embedRoutes, type EmbedEnv } from './customer/embed.ts';
import { ticketRoutes } from './customer/ticket.ts';
import { connect } from 'cloudflare:sockets';
import type { Deliver } from './mail/notify.ts';
import { socketDeliver, type SmtpSocket } from './mail/socket.ts';
import { deskRoutes, type DeskBindings } from './desk/routes.ts';
import { uploadRoutes, type UploadBindings } from './uploads/routes.ts';

// The Durable Object classes wrangler.jsonc binds must be exported from the entry point.
export { TicketTimer } from './timers/ticket-timer.ts';

/**
 * ShyDesk's single Worker (shyden-labs/shydesk#14). Staff routes need the
 * Access settings and FIRST_ADMIN_EMAIL: without the Access settings they
 * answer 401 to everyone; with them but no FIRST_ADMIN_EMAIL, a signed-in
 * person gets 503 naming it (shyden-labs/shydesk#81).
 */
type AppBindings = DocsEnv & ContactBindings & EmbedEnv & UploadBindings & DeskBindings;

/**
 * Mail delivery for the Worker (shyden-labs/shydesk#68): each mail goes over a
 * fresh STARTTLS socket to the SMTP_HOST setting on port 587. Without it, or
 * without the sender's login, a send fails by name and the customer is told
 * to keep the private link.
 */
// The runtime's Socket streams are the web streams SmtpSocket names; only their declared types differ
// (@cloudflare/workers-types marks a finished read's value optional).
export const workerDeliver: Deliver = socketDeliver((address, options) => connect(address, options) as unknown as SmtpSocket);

/** The Worker's routes. `jwks` stands in Access's keys, for the local e2e entry only. */
export function createApp(jwks?: JWTVerifyGetKey): Hono<{ Bindings: AppBindings }> {
  const app = new Hono<{ Bindings: AppBindings }>();
  // What a deploy is read back with: answers without touching any binding.
  app.get('/health', (c) => c.json({ ok: true }));

  app.route('/', adminRoutes(jwks));
  app.route('/', apiRoutes());
  app.route('/', docsRoutes(jwks));
  app.route('/', deskRoutes({ deliver: workerDeliver }, jwks));
  // Before contact: its origin check covers all of /support-api, and this answers first with its own.
  app.route('/', uploadRoutes());
  app.route('/', ticketRoutes());
  app.route('/', contactRoutes({ fetcher: fetch.bind(globalThis), deliver: workerDeliver }));
  app.route('/', embedRoutes());
  return app;
}

export const app = createApp();

export default app;
