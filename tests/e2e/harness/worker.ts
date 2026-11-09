import type { ExecutionContext } from '@cloudflare/workers-types';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { createApp } from '../../../src/index.ts';

export { TicketTimer } from '../../../src/timers/ticket-timer.ts';

/**
 * The Worker as the e2e suite runs it (shyden-labs/shydesk#24): every real route
 * and binding, with only Cloudflare Access stood in. Access sits at Cloudflare's
 * edge, where it turns its sign-in cookie into the header the Worker verifies; here
 * this does that step, and the Worker checks the token against the suite's own key.
 */
export default {
  fetch(request: Request, env: { E2E_ACCESS_JWKS: string }, context: ExecutionContext): Response | Promise<Response> {
    const token = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1];
    const forwarded = new Request(request);
    if (token !== undefined) forwarded.headers.set('Cf-Access-Jwt-Assertion', token);
    const keys = createLocalJWKSet(JSON.parse(env.E2E_ACCESS_JWKS) as JSONWebKeySet);
    return createApp(keys).fetch(forwarded, env, context);
  },
};
