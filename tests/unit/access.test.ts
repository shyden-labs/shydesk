import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey } from 'jose';
import { AuthError, verifyAccess, type AccessEnv } from '../../src/auth/access.ts';

/**
 * Staff sign-in through Cloudflare Access (shyden-labs/shydesk#16): the Worker
 * verifies the Access JWT itself and never trusts a header alone. Tokens are
 * signed by a key made here; the key set is a local stand-in, and the one test
 * of the default key set stands in `fetch`, so no connection is opened.
 */

const TEAM = 'shydesk-test.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-desk';
const env: AccessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let signer: Key;
let otherSigner: Key;
let publicJwk: JWK;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  signer = pair.privateKey;
  otherSigner = other.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface TokenOptions {
  claims?: Record<string, unknown>;
  aud?: string;
  iss?: string;
  exp?: number | string;
  nbf?: number | string;
  key?: Key;
}

async function token(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ email: 'Rep@Example.com', ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setAudience(options.aud ?? AUD)
    .setIssuer(options.iss ?? `https://${TEAM}`)
    .setExpirationTime(options.exp ?? '5m');
  if (options.nbf !== undefined) jwt.setNotBefore(options.nbf);
  return jwt.sign(options.key ?? signer);
}

function request(headers: Record<string, string>): Request {
  return new Request('https://shydesk.example/desk', { headers });
}

async function refusal(promise: Promise<unknown>): Promise<AuthError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).status).toBe(401);
  return error as AuthError;
}

describe('verifyAccess', () => {
  it('accepts a token signed by Access with the right aud and iss, and returns the email lower-cased', async () => {
    const jwt = await token();
    await expect(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks)).resolves.toEqual({
      email: 'rep@example.com',
    });
  });

  it('refuses a token for another Access application (wrong aud)', async () => {
    const jwt = await token({ aud: 'some-other-app' });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
  });

  it('refuses a token from another Access team (wrong iss)', async () => {
    const jwt = await token({ iss: 'https://someone-else.cloudflareaccess.com' });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
  });

  it('refuses an expired token', async () => {
    const jwt = await token({ exp: Math.floor(Date.now() / 1000) - 60 });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
  });

  it('refuses a token not yet valid (nbf in the future)', async () => {
    const jwt = await token({ nbf: Math.floor(Date.now() / 1000) + 600 });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
  });

  it('refuses a request with no Access token', async () => {
    const error = await refusal(verifyAccess(request({}), env, jwks));
    expect(error.message).toMatch(/no Access token/);
  });

  it('refuses the Access email header on its own, without a token', async () => {
    await refusal(verifyAccess(request({ 'Cf-Access-Authenticated-User-Email': 'admin@example.com' }), env, jwks));
  });

  it('takes the email from the verified token, never from the email header beside it', async () => {
    const jwt = await token();
    const result = await verifyAccess(
      request({ 'Cf-Access-Jwt-Assertion': jwt, 'Cf-Access-Authenticated-User-Email': 'admin@example.com' }),
      env,
      jwks,
    );
    expect(result).toEqual({ email: 'rep@example.com' });
  });

  it('refuses a token signed by a key Access does not publish', async () => {
    const jwt = await token({ key: otherSigner });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
  });

  it('refuses an unsigned token (alg none)', async () => {
    const encode = (part: object): string => Buffer.from(JSON.stringify(part)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'none' })}.${encode({ email: 'a@b.c', aud: AUD, iss: `https://${TEAM}`, exp: now + 300 })}.`;
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': unsigned }), env, jwks));
  });

  it('refuses a token that is not a JWT at all', async () => {
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': 'not-a-jwt' }), env, jwks));
  });

  it('refuses a verified token with no email claim (a service token)', async () => {
    const jwt = await token({ claims: { email: undefined } });
    const error = await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
    expect(error.message).toMatch(/no email/);
  });

  it('refuses a verified token whose email claim is not a string', async () => {
    const jwt = await token({ claims: { email: ['admin@example.com'] } });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
  });

  it('refuses a verified token whose email claim is empty', async () => {
    const jwt = await token({ claims: { email: '  ' } });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), env, jwks));
  });

  it('refuses everything when the team domain is not configured', async () => {
    const jwt = await token();
    const error = await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), { ...env, ACCESS_TEAM_DOMAIN: '' }, jwks));
    expect(error.message).toMatch(/not configured/);
  });

  it('refuses everything when the aud tag is not configured', async () => {
    const jwt = await token({ aud: '' });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), { ...env, ACCESS_AUD: '' }, jwks));
  });

  it('fetches the keys from the team certs address when no key set is given, once per team', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (input: Request | URL | string) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(Response.json({ keys: [publicJwk] }));
    });
    const team = 'fetch-test.cloudflareaccess.com';
    const jwt = await token({ iss: `https://${team}` });
    const teamEnv = { ...env, ACCESS_TEAM_DOMAIN: team };
    await expect(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), teamEnv)).resolves.toEqual({
      email: 'rep@example.com',
    });
    await expect(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), teamEnv)).resolves.toEqual({
      email: 'rep@example.com',
    });
    expect(fetched).toEqual([`https://${team}/cdn-cgi/access/certs`]);
  });

  it('refuses when the team certs cannot be fetched', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('down', { status: 503 })));
    const team = 'down-test.cloudflareaccess.com';
    const jwt = await token({ iss: `https://${team}` });
    await refusal(verifyAccess(request({ 'Cf-Access-Jwt-Assertion': jwt }), { ...env, ACCESS_TEAM_DOMAIN: team }));
  });
});
