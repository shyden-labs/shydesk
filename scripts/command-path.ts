import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where a command is looked for, in order, never the caller's PATH (SonarCloud S4036,
 * shyden-labs/shydesk#291). The agent's GitHub App router lives in ~/.local/bin, so on
 * the laptop gh still acts as this project's App; CI's tools are in /usr/bin.
 */
export const FIXED_DIRS: readonly string[] = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/** The absolute path of `name` in the first fixed folder holding it, or a throw naming every folder looked in. */
export function commandPath(
  name: string,
  { dirs = FIXED_DIRS, exists = existsSync }: { dirs?: readonly string[]; exists?: (path: string) => boolean } = {},
): string {
  const found = dirs.map((dir) => join(dir, name)).find((path) => exists(path));
  if (found === undefined) throw new Error(`${name} is in none of the fixed folders: ${dirs.join(', ')}`);
  return found;
}

const NPM_BIN = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin');
/** npm and npx as the running node's own copy, run as `process.execPath` with the script first. */
export const NPM_CLI = join(NPM_BIN, 'npm-cli.js');
export const NPX_CLI = join(NPM_BIN, 'npx-cli.js');
