/**
 * The global licence rule (2026-10-07), checked against package-lock.json:
 * a shipped package must be permissive; a build or test tool may also be LGPL
 * or MPL; GPL, AGPL, SSPL, a missing licence and any licence not listed here
 * are refused (shyden-labs/repo-template#169). npm records each package's
 * licence in the lockfile, so the check reads no network and starts no process.
 */

export type Use = 'shipped' | 'build';

export interface LockEntry {
  version?: string;
  license?: string;
  dev?: boolean;
  devOptional?: boolean;
  link?: boolean;
  resolved?: string;
}

export interface LockFile {
  packages: Record<string, LockEntry>;
}

const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

/** Allowed for build and test tools only. */
const WEAK_COPYLEFT = new Set(['LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MPL-2.0']);

function accepts(id: string, use: Use): boolean {
  return PERMISSIVE.has(id) || (use === 'build' && WEAK_COPYLEFT.has(id));
}

/**
 * Reads an SPDX expression of licence ids, AND, OR and parentheses (AND binds
 * tighter). Anything else, such as WITH, makes the expression unreadable.
 */
function evaluate(expression: string, use: Use): boolean | undefined {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;

  const term = (): boolean | undefined => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = either();
      return tokens[at++] === ')' ? inner : undefined;
    }
    if (token === undefined || ['AND', 'OR', 'WITH', ')'].includes(token)) return undefined;
    return accepts(token, use);
  };
  const both = (): boolean | undefined => {
    let value = term();
    while (value !== undefined && tokens[at] === 'AND') {
      at++;
      const right = term();
      value = right === undefined ? undefined : value && right;
    }
    return value;
  };
  const either = (): boolean | undefined => {
    let value = both();
    while (value !== undefined && tokens[at] === 'OR') {
      at++;
      const right = both();
      value = right === undefined ? undefined : value || right;
    }
    return value;
  };

  const value = either();
  return at === tokens.length ? value : undefined;
}

/** Whether the rule accepts a package with this licence, used this way. */
export function licenceVerdict(licence: string | undefined, use: Use): boolean {
  return evaluate(licence ?? '', use) === true;
}

/** Each installed package the rule refuses, as `path@version (use): licence`. */
export function licenceProblems(lock: LockFile): string[] {
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path !== '' && entry.link !== true)
    .flatMap(([path, entry]) => {
      const use: Use = entry.dev === true ? 'build' : 'shipped';
      if (licenceVerdict(entry.license, use)) return [];
      const label = use === 'build' ? 'build only' : 'shipped';
      return [`${path}@${entry.version ?? '?'} (${label}): ${entry.license ?? 'no licence'}`];
    });
}
