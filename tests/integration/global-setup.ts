// One disposable D1 database per run: created, migrated, handed to the tests,
// then deleted (shyden-labs/shydesk#15). Its name carries the run, so a
// leftover one is traceable to the CI run that left it.
import { readFile } from 'node:fs/promises';
import type { TestProject } from 'vitest/node';
import { createDatabase, deleteDatabase, query } from './d1.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseId: string;
  }
}

export const MIGRATIONS = ['migrations/0001_release_1.sql'];

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const run = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const id = await createDatabase(`shydesk-ci-${run}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`);
  try {
    for (const file of MIGRATIONS) {
      await query(id, await readFile(file, 'utf8'));
    }
  } catch (error) {
    await deleteDatabase(id);
    throw error;
  }
  project.provide('databaseId', id);
  return () => deleteDatabase(id);
}
