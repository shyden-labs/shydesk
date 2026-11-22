import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// docs/pse-registration.md is pasted into each product's PSE registration and privacy page, so it must agree with
// the deployed configuration it describes (shyden-labs/shydesk#258).
const doc = readFileSync(new URL('../../docs/pse-registration.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const wrangler = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
const config = JSON.parse(wrangler.replace(/,(\s*[}\]])/g, '$1')) as {
  observability?: { enabled?: boolean };
  routes?: { pattern: string; custom_domain?: boolean }[];
};

describe('docs/pse-registration.md', () => {
  it('names Workers Logs and their retention while wrangler.jsonc keeps them on', () => {
    expect(config.observability?.enabled).toBe(true);
    expect(doc).not.toMatch(/Workers Logs are off/i);
    expect(doc).not.toMatch(/No request logs are kept/i);
    expect(doc).toContain('Workers Logs');
    expect(doc).toContain('3 days on Workers Free');
  });

  it('gives the live address as served, not planned', () => {
    const live = config.routes?.find((route) => route.custom_domain === true)?.pattern;
    expect(live).toBe('shydesk.dpdns.org');
    expect(doc).toContain(`https://${String(live)}`);
    expect(doc).not.toMatch(/\(planned\)/);
    expect(doc).not.toMatch(/none served yet/);
  });
});
