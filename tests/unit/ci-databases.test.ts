// Which leftover CI databases the integration suite sweeps before it starts
// (shyden-labs/shydesk#15): only its own `shydesk-ci-` ones, and only once
// older than an hour, so a run still in progress keeps its database.
import { describe, expect, it } from 'vitest';
import { staleCiDatabases } from '../integration/d1.ts';

const now = Date.parse('2026-11-05T12:00:00Z');

describe('staleCiDatabases', () => {
  it('picks a CI database created more than an hour ago', () => {
    expect(staleCiDatabases([{ uuid: 'a', name: 'shydesk-ci-1-1', created_at: '2026-11-05T10:59:59Z' }], now)).toEqual(['a']);
  });
  it('keeps a CI database exactly an hour old, as a run may still hold it', () => {
    expect(staleCiDatabases([{ uuid: 'a', name: 'shydesk-ci-1-1', created_at: '2026-11-05T11:00:00Z' }], now)).toEqual([]);
  });
  it('keeps a CI database created a minute ago', () => {
    expect(staleCiDatabases([{ uuid: 'a', name: 'shydesk-ci-2-1', created_at: '2026-11-05T11:59:00Z' }], now)).toEqual([]);
  });
  it('never picks the dev database, however old', () => {
    expect(staleCiDatabases([{ uuid: 'd', name: 'shydesk', created_at: '2026-01-01T00:00:00Z' }], now)).toEqual([]);
  });
  it('never picks a database whose name only contains the prefix', () => {
    expect(staleCiDatabases([{ uuid: 'x', name: 'old-shydesk-ci-1', created_at: '2026-01-01T00:00:00Z' }], now)).toEqual([]);
  });
  it('keeps a database whose creation time cannot be read', () => {
    expect(staleCiDatabases([{ uuid: 'u', name: 'shydesk-ci-3-1', created_at: 'not a date' }], now)).toEqual([]);
  });
});
