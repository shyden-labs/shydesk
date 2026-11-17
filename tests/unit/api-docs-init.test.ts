import { afterEach, describe, expect, it, vi } from 'vitest';

// The docs page's start-up script (shyden-labs/shydesk#26, shyden-labs/shydesk#83):
// Swagger UI's "Try it out" offers only the methods try.json names, and reads only
// when it cannot tell. The script runs on import, so each test loads it afresh.
type Options = { url: string; dom_id: string; deepLinking: boolean; supportedSubmitMethods: string[] };

async function start(answer: () => Promise<Response>): Promise<{ options: Options; asked: unknown[][] }> {
  const asked: unknown[][] = [];
  let resolve: (options: Options) => void = () => undefined;
  const started = new Promise<Options>((done) => {
    resolve = done;
  });
  vi.stubGlobal('SwaggerUIBundle', (options: Options) => {
    resolve(options);
  });
  vi.stubGlobal('fetch', (...args: unknown[]) => {
    asked.push(args);
    return answer();
  });
  vi.resetModules();
  await import('../../public/api/docs/init.js');
  return { options: await started, asked };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the docs page start-up', () => {
  it('asks try.json on its own origin and starts Swagger UI on the spec with the methods it names', async () => {
    const { options, asked } = await start(() => Promise.resolve(Response.json({ methods: ['get', 'post', 7] })));
    expect(asked).toEqual([['try.json', { credentials: 'same-origin' }]]);
    expect(options).toEqual({
      url: 'shydesk.v1.yaml',
      dom_id: '#swagger-ui',
      deepLinking: true,
      supportedSubmitMethods: ['get', 'post'],
    });
  });

  it('offers reads only when try.json answers with an error', async () => {
    const { options } = await start(() => Promise.resolve(Response.json({ methods: ['post'] }, { status: 500 })));
    expect(options.supportedSubmitMethods).toEqual(['get']);
  });

  it('offers reads only when the methods are not a list', async () => {
    const { options } = await start(() => Promise.resolve(Response.json({ methods: 'post' })));
    expect(options.supportedSubmitMethods).toEqual(['get']);
  });

  it('offers reads only when the answer names no methods', async () => {
    const { options } = await start(() => Promise.resolve(Response.json({ other: 1 })));
    expect(options.supportedSubmitMethods).toEqual(['get']);
  });

  it('offers reads only when the answer is null', async () => {
    const { options } = await start(() => Promise.resolve(Response.json(null)));
    expect(options.supportedSubmitMethods).toEqual(['get']);
  });

  it('offers reads only when the answer is not an object', async () => {
    const { options } = await start(() => Promise.resolve(Response.json('post')));
    expect(options.supportedSubmitMethods).toEqual(['get']);
  });

  it('offers reads only when try.json cannot be fetched', async () => {
    const { options } = await start(() => Promise.reject(new TypeError('offline')));
    expect(options.supportedSubmitMethods).toEqual(['get']);
  });
});
