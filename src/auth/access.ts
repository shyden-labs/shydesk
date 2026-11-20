import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Staff sign-in through Cloudflare Access (shyden-labs/shydesk#16). Access sits
 * in front of the desk and admin paths; the Worker still verifies Access's JWT
 * on every request and never trusts a header without it (design: Staff sign-in).
 */

/** The settings Access verification reads: the team's domain and the application's aud tag. */
export interface AccessEnv {
  /** e.g. `shydesk.cloudflareaccess.com`: issuer and key-set host. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's Audience (AUD) tag. */
  ACCESS_AUD: string;
}

/** A sign-in refusal; always answered 401. */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** One key set per team, so its keys are fetched once and reused while the Worker lives. */
const keySets = new Map<string, JWTVerifyGetKey>();

function teamKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` token: Access's signature (RS256), its
 * team as issuer, this application as audience, and its times. Returns the
 * email inside the token, lower-cased. Throws `AuthError` for anything else,
 * including missing settings, so a misconfigured deploy lets nobody in.
 */
export async function verifyAccess(request: Request, env: AccessEnv, jwks?: JWTVerifyGetKey): Promise<{ email: string }> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new AuthError('Access is not configured');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new AuthError('no Access token');
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, jwks ?? teamKeys(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
    }));
  } catch (error) {
    throw new AuthError(`Access token refused: ${(error as Error).message}`);
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) throw new AuthError('Access token carries no email');
  return { email };
}
