/**
 * The global licence rule (2026-10-07; purpose ruled 2026-11-09), checked
 * against package-lock.json: a package is refused only when using it would go
 * against our own licence. GPL, AGPL and SSPL are refused, and so is a missing
 * or unlisted licence, which cannot be judged. Permissive licences and weak
 * copyleft pass, shipped or not (shyden-labs/repo-template#169). npm records each
 * package's licence in the lockfile, so the check reads no network and starts
 * no process.
 */

export interface LockEntry {
  version?: string;
  license?: string;
  dev?: boolean;
  link?: boolean;
  resolved?: string;
}

export interface LockFile {
  packages: Record<string, LockEntry>;
}

const ACCEPTED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'PSF-2.0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
  // Weak copyleft: its terms reach only its own files, not ours.
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MPL-2.0',
]);

/**
 * Licences read from a package's own files where its package.json names none,
 * keyed by lockfile path and exact version so a new version is judged again.
 * css-value 0.0.1 (webdriverio's dependency): its Readme.md carries the full
 * MIT licence text, Copyright (c) 2012 TJ Holowaychuk (shyden-labs/shydesk#42).
 */
const RECORDED: Readonly<Record<string, string>> = {
  'node_modules/css-value@0.0.1': 'MIT',
};

/**
 * Reads an SPDX expression of licence ids, AND, OR and parentheses (AND binds
 * tighter). Anything else, such as WITH, makes the expression unreadable.
 */
function evaluate(expression: string): boolean | undefined {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;

  const term = (): boolean | undefined => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = either();
      return tokens[at++] === ')' ? inner : undefined;
    }
    if (token === undefined || ['AND', 'OR', 'WITH', ')'].includes(token)) return undefined;
    return ACCEPTED.has(token);
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

/** Whether the rule accepts a package with this licence. */
export function licenceVerdict(licence: string | undefined): boolean {
  return evaluate(licence ?? '') === true;
}

/** Each installed package the rule refuses, as `path@version: licence`. */
export function licenceProblems(lock: LockFile): string[] {
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path !== '' && entry.link !== true)
    .flatMap(([path, entry]) => {
      const licence = entry.license ?? RECORDED[`${path}@${entry.version ?? '?'}`];
      if (licenceVerdict(licence)) return [];
      return [`${path}@${entry.version ?? '?'}: ${entry.license ?? 'no licence'}`];
    });
}
