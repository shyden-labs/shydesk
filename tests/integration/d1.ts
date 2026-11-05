// A thin client for the Cloudflare D1 REST API, used by the integration suite
// to create a disposable database on ShyDesk Non-Prod, run SQL in it and
// delete it again (shyden-labs/shydesk#15). CI supplies the account and a
// D1-only token from the `dev-ci` environment; a missing one fails the run
// naming it, never skips.

const API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export interface Statement {
  results: Record<string, unknown>[];
  success: boolean;
}

/** Reads a required variable, failing with where to set it. */
export function required(name: 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_TOKEN'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set: the integration suite reads it from the dev-ci GitHub environment.`);
  }
  return value;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`, 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${API}/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}${path}`, init);
  const envelope = (await response.json()) as Envelope<T>;
  if (!envelope.success) {
    throw new Error(`D1 ${method} ${path} failed (${response.status}): ${envelope.errors.map((e) => e.message).join('; ')}`);
  }
  return envelope.result;
}

/** Creates an empty database in the APAC region and returns its id. */
export async function createDatabase(name: string): Promise<string> {
  const result = await call<{ uuid: string }>('POST', '/d1/database', { name, primary_location_hint: 'apac' });
  return result.uuid;
}

export async function deleteDatabase(id: string): Promise<void> {
  await call<unknown>('DELETE', `/d1/database/${id}`);
}

/** Runs SQL (one or more statements) and returns each statement's rows. */
export function query(id: string, sql: string, params: unknown[] = []): Promise<Statement[]> {
  return call<Statement[]>('POST', `/d1/database/${id}/query`, { sql, params });
}
