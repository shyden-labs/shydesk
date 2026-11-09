import { describe, expect, it } from 'vitest';
import { embedRoutes } from '../../src/customer/embed.ts';

// The shared piece is one script, served from the static assets at /embed.js
// to any page (a script tag needs no CORS), cacheable, and allowed to load
// cross-origin (shyden-labs/shydesk#19).
function appWith(asset = new Response('/* piece */', { headers: { 'Content-Type': 'text/javascript', ETag: '"abc"' } })) {
  const asked: string[] = [];
  const ASSETS = {
    fetch: (request: Request) => {
      asked.push(new URL(request.url).pathname);
      return Promise.resolve(asset);
    },
  };
  const call = () => embedRoutes().request('https://shydesk.dpdns.org/embed.js', {}, { ASSETS });
  return { call, asked };
}

describe('GET /embed.js', () => {
  it('serves the piece from the static assets', async () => {
    const { call, asked } = appWith();
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('/* piece */');
    expect(asked).toEqual(['/embed.js']);
  });

  it('is cacheable for five minutes, keeps the content ETag and may load on any site', async () => {
    const response = await appWith().call();
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('ETag')).toBe('"abc"');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('passes on a missing asset as it is, never caching it', async () => {
    const response = await appWith(new Response('gone', { status: 404 })).call();
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBeNull();
  });
});

// shyden-labs/shydesk#21: the piece imports its media code on the first file
// picked. A cross-origin import needs CORS, which a script tag does not.
describe.each(['/embed-media.js', '/embed-video.js'])('GET %s', (path) => {
  const asset = () => new Response('/* media */', { headers: { 'Content-Type': 'text/javascript', ETag: '"abc"' } });
  const call = (body = asset()) =>
    embedRoutes().request(`https://shydesk.dpdns.org${path}`, {}, { ASSETS: { fetch: () => Promise.resolve(body) } });

  it('serves the media code to any site, with CORS, cacheable like the piece', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('/* media */');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it('passes on a missing asset as it is', async () => {
    const response = await call(new Response('gone', { status: 404 }));
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
