// Starts Swagger UI on the spec served beside this page (shyden-labs/shydesk#26).
// Kept out of the page so the docs' Content-Security-Policy allows no inline script.
// swagger-ui-bundle.js, loaded first, puts SwaggerUIBundle on the global object.
// "Try it out" sends only what this host allows (try.json, shyden-labs/shydesk#83):
// every method on Non-Prod, reads only on live, and reads only if it cannot tell.
const { SwaggerUIBundle } = /** @type {{ SwaggerUIBundle: (options: object) => unknown }} */ (/** @type {unknown} */ (globalThis));

/** @returns {Promise<string[]>} */
async function allowedMethods() {
  try {
    const answer = await fetch('try.json', { credentials: 'same-origin' });
    const body = /** @type {unknown} */ (await answer.json());
    const methods = typeof body === 'object' && body !== null && 'methods' in body ? body.methods : undefined;
    return answer.ok && Array.isArray(methods) ? methods.filter((m) => typeof m === 'string') : ['get'];
  } catch {
    return ['get'];
  }
}

void allowedMethods().then((methods) => {
  SwaggerUIBundle({
    url: 'shydesk.v1.yaml',
    dom_id: '#swagger-ui',
    deepLinking: true,
    supportedSubmitMethods: methods,
  });
});
