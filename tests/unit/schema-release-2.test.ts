// The Release 2 migration's text (shyden-labs/shydesk#57): every table the plan
// lists is created, one appeal per punishment and one punishment per appeal
// link are keys, and no Release 1 table is dropped or recreated.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(new URL('../../migrations/0004_release_2.sql', import.meta.url), 'utf8');

// The migration with its comments removed and its whitespace collapsed.
const statements = SQL.replace(/--.*$/gm, '')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

function createTable(name: string): string | undefined {
  return statements.find((s) => s.startsWith(`CREATE TABLE ${name} (`));
}

describe('Release 2 migration', () => {
  it('creates the reports table', () => {
    expect(createTable('reports')).toBeDefined();
  });
  it('creates the punishments table', () => {
    expect(createTable('punishments')).toBeDefined();
  });
  it('creates the appeals table', () => {
    expect(createTable('appeals')).toBeDefined();
  });
  it('creates the legal_holds table', () => {
    expect(createTable('legal_holds')).toBeDefined();
  });
  it('creates the legal_hold_events table', () => {
    expect(createTable('legal_hold_events')).toBeDefined();
  });
  it('creates the authority_reports table', () => {
    expect(createTable('authority_reports')).toBeDefined();
  });

  it('keys appeals by punishment, so a punishment has at most one appeal', () => {
    expect(createTable('appeals')).toContain('punishment_id TEXT PRIMARY KEY REFERENCES punishments (id)');
  });
  it('keeps each appeal link token hash unique', () => {
    expect(createTable('punishments')).toContain('appeal_token_hash TEXT NOT NULL UNIQUE');
  });

  it('adds the four product settings columns', () => {
    expect(statements.filter((s) => s.startsWith('ALTER TABLE products ADD COLUMN ')).map((s) => s.split(' ')[5])).toEqual([
      'punishments_json',
      'callback_url',
      'callback_secret',
      'appeal_page_url',
    ]);
  });

  it('only creates tables and indexes, or adds product columns', () => {
    const others = statements.filter(
      (s) => !/^CREATE TABLE \w+ \(/.test(s) && !/^CREATE INDEX \w+ ON \w+ \(/.test(s) && !s.startsWith('ALTER TABLE products ADD COLUMN '),
    );
    expect(others).toEqual([]);
  });
  it('creates no table that Release 1 already has', () => {
    const release1 = readFileSync(new URL('../../migrations/0001_release_1.sql', import.meta.url), 'utf8');
    const existing = [...release1.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
    const created = statements.flatMap((s) => /^CREATE TABLE (\w+)/.exec(s)?.[1] ?? []);
    expect(existing.length).toBeGreaterThan(0);
    expect(created.filter((t) => existing.includes(t))).toEqual([]);
  });
});
