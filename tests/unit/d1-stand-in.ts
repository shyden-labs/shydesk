import type { D1Database } from '@cloudflare/workers-types';

/**
 * A D1 stand-in for unit tests: no database, just a record of every statement
 * (its SQL, bound values and how it was run) and a test-supplied `answer` for
 * the rows each read returns. Statements sent with `batch` are recorded with
 * `method: 'batch'`, in order, so a test can read what was written together.
 */

export interface Statement {
  sql: string;
  values: unknown[];
  method: 'first' | 'all' | 'run' | 'batch';
}

export type Answer = (sql: string, values: unknown[]) => Record<string, unknown>[];

export interface StandIn {
  db: D1Database;
  statements: Statement[];
}

const none: Answer = () => [];

export function standInDb(answer: Answer = none): StandIn {
  const statements: Statement[] = [];
  const read = (s: Omit<Statement, 'method'>, method: Statement['method']): Record<string, unknown>[] => {
    statements.push({ ...s, method });
    return answer(s.sql, s.values);
  };
  const prepared = (sql: string, values: unknown[] = []) => ({
    sql,
    values,
    bind: (...bound: unknown[]) => prepared(sql, bound),
    first: () => Promise.resolve(read({ sql, values }, 'first')[0] ?? null),
    all: () => Promise.resolve({ results: read({ sql, values }, 'all'), success: true, meta: {} }),
    run: () => Promise.resolve({ results: read({ sql, values }, 'run'), success: true, meta: {} }),
  });
  const batch = (list: { sql: string; values: unknown[] }[]) =>
    Promise.resolve(list.map((s) => ({ results: read(s, 'batch'), success: true, meta: {} })));
  return { db: { prepare: (sql: string) => prepared(sql), batch } as unknown as D1Database, statements };
}
