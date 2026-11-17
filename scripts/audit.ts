/**
 * CI's dependency audit (shyden-labs/shydesk#203):
 *
 *   node scripts/audit.ts
 *
 * Runs `npm audit --json` and fails naming every advisory (low severity and
 * up, as `--audit-level=low` did) unless `audit-exceptions.json` excepts that
 * advisory in that package and the exception has not expired. An exception is
 * Shyden's ruling only (2026-11-18: GHSA-fc5q-39xc-vjpf in picomatch, which has
 * no patched version, until 2026-12-01). npm failing to run or to print a
 * report fails closed, naming why.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runIfEntry } from './cli.ts';

export interface AuditException {
  /** The advisory id, e.g. GHSA-fc5q-39xc-vjpf. */
  advisory: string;
  /** The package the advisory is in; the exception covers no other. */
  package: string;
  /** First day (YYYY-MM-DD) the exception no longer holds. */
  expires: string;
  ticket: string;
  why: string;
}

export interface Advisory {
  id: string;
  package: string;
  severity: string;
}

interface Via {
  url?: string;
  name?: string;
  severity?: string;
}

interface Report {
  vulnerabilities: Record<string, { via: (string | Via)[] }>;
}

function isReport(value: unknown): value is Report {
  return typeof value === 'object' && value !== null && 'vulnerabilities' in value && typeof value.vulnerabilities === 'object';
}

/** Each advisory in an `npm audit --json` report, once, info level left out. */
export function advisories(output: string): Advisory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  if (!isReport(parsed)) throw new Error(`npm audit did not print a JSON report:\n${output}`);
  const found = new Map<string, Advisory>();
  for (const { via } of Object.values(parsed.vulnerabilities)) {
    for (const v of via) {
      // A string is a package this one only depends on; its advisory is listed under it.
      if (typeof v === 'string' || v.severity === 'info') continue;
      const id = String(v.url).replace(/^.*\//, '');
      const advisory = { id, package: String(v.name), severity: String(v.severity) };
      found.set(`${advisory.id} ${advisory.package}`, advisory);
    }
  }
  return [...found.values()];
}

/** Why each advisory is not allowed on `today` (YYYY-MM-DD); empty when all are. */
export function problems(found: Advisory[], exceptions: AuditException[], today: string): string[] {
  return found.flatMap((a) => {
    const name = `${a.id} (${a.package}, ${a.severity})`;
    const exception = exceptions.find((e) => e.advisory === a.id && e.package === a.package);
    if (!exception) return [`${name}: no exception`];
    if (today >= exception.expires) return [`${name}: its exception expired on ${exception.expires} (${exception.ticket})`];
    return [];
  });
}

export function main(): number {
  const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`npm audit did not run: ${run.error.message}`);
  const { exceptions } = JSON.parse(readFileSync(new URL('../audit-exceptions.json', import.meta.url), 'utf8')) as {
    exceptions: AuditException[];
  };
  const found = advisories(run.stdout);
  const wrong = problems(found, exceptions, new Date().toISOString().slice(0, 10));
  if (wrong.length > 0) {
    const noun = wrong.length === 1 ? 'advisory' : 'advisories';
    throw new Error(`npm audit found ${wrong.length} ${noun} not allowed:\n${wrong.join('\n')}`);
  }
  console.log(`npm audit: every advisory found (${found.length}) is excepted until its expiry`);
  return 0;
}

await runIfEntry(import.meta.url, main);
