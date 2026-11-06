// Starts Swagger UI on the spec served beside this page (shyden-labs/shydesk#26).
// Kept out of the page so the docs' Content-Security-Policy allows no inline script.
// swagger-ui-bundle.js, loaded first, puts SwaggerUIBundle on the global object.
const { SwaggerUIBundle } = /** @type {{ SwaggerUIBundle: (options: object) => unknown }} */ (/** @type {unknown} */ (globalThis));
SwaggerUIBundle({
  url: 'shydesk.v1.yaml',
  dom_id: '#swagger-ui',
  deepLinking: true,
});
