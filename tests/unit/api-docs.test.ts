import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { docsRoutes, type DocsEnv } from '../../src/api/docs.ts';
import { standInDb, type Answer } from './d1-stand-in.ts';

// The API docs (shyden-labs/shydesk#26): a self-hosted Swagger UI and the spec
// at /api/docs/, for staff only. The files are Worker static assets, fetched
// through the ASSETS binding only after the Access token and staff check pass.
const TEAM = 'shydesk-test.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-desk';
const ADMIN = 'admin@example.com';
const REP = 'rep@example.com';

let jwks: JWTVerifyGetKey;
let sign: (email: string) => Promise<string>;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
  sign = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setAudience(AUD)
      .setIssuer(`https://${TEAM}`)
      .setExpirationTime('5m')
      .sign(pair.privateKey);
});

function docs() {
  const answer: Answer = (sql, values) => (sql.includes('FROM staff ') && values[0] === REP ? [{ role: 'rep' }] : []);
  const fetched: string[] = [];
  const env: DocsEnv = {
    DB: standInDb(answer).db,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    FIRST_ADMIN_EMAIL: ADMIN,
    ASSETS: {
      fetch: (request: Request) => {
        fetched.push(new URL(request.url).pathname);
        return Promise.resolve(new Response('asset body', { headers: { 'Content-Type': 'text/html' } }));
      },
    } as unknown as DocsEnv['ASSETS'],
  };
  const app = docsRoutes(jwks);
  const get = async (path: string, email?: string) =>
    app.request(path, { headers: email ? { 'Cf-Access-Jwt-Assertion': await sign(email) } : {} }, env);
  return { get, fetched };
}

describe('/api/docs', () => {
  it('serves the docs page from the static assets to an admin', async () => {
    const { get, fetched } = docs();
    const response = await get('/api/docs/', ADMIN);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('asset body');
    expect(fetched).toEqual(['/api/docs/']);
  });

  it('serves the spec and the Swagger UI files to a rep', async () => {
    const { get, fetched } = docs();
    expect((await get('/api/docs/shydesk.v1.yaml', REP)).status).toBe(200);
    expect((await get('/api/docs/swagger-ui-bundle.js', REP)).status).toBe(200);
    expect(fetched).toEqual(['/api/docs/shydesk.v1.yaml', '/api/docs/swagger-ui-bundle.js']);
  });

  it('keeps the page private and limited to its own files', async () => {
    const { get } = docs();
    const response = await get('/api/docs/', ADMIN);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Type')).toBe('text/html');
  });

  it('sends /api/docs on to /api/docs/ for staff', async () => {
    const { get, fetched } = docs();
    const response = await get('/api/docs', ADMIN);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/api/docs/');
    expect(fetched).toEqual([]);
  });

  it.each(['/api/docs', '/api/docs/', '/api/docs/shydesk.v1.yaml'])(
    'refuses %s without an Access token with 401 and fetches nothing',
    async (path) => {
      const { get, fetched } = docs();
      expect((await get(path)).status).toBe(401);
      expect(fetched).toEqual([]);
    },
  );

  it('refuses someone Access let in who is not staff with 403 and fetches nothing', async () => {
    const { get, fetched } = docs();
    expect((await get('/api/docs/', 'stranger@example.com')).status).toBe(403);
    expect(fetched).toEqual([]);
  });
});
