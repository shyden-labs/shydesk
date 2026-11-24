import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { commandPath, FIXED_DIRS, NPM_CLI, NPX_CLI } from '../../scripts/command-path.ts';

// SonarCloud S4036 (shyden-labs/shydesk#291): a command is run by its absolute
// path, found in fixed folders, never through the caller's PATH. The agent's
// GitHub App router (~/.local/bin/gh) is looked at first, so gh still acts as
// the project's App on the laptop; CI's gh is in /usr/bin.
const has =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe('commandPath', () => {
  it('looks in the router folder, then Homebrew, then the system folders, in that order', () => {
    expect(FIXED_DIRS).toEqual([join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);
  });

  it('answers the first fixed folder holding the command', () => {
    const exists = has('/opt/homebrew/bin/git', '/usr/bin/git');
    expect(commandPath('git', { exists })).toBe('/opt/homebrew/bin/git');
  });

  it('answers the router gh before any other gh', () => {
    const router = join(homedir(), '.local', 'bin', 'gh');
    expect(commandPath('gh', { exists: has(router, '/usr/bin/gh') })).toBe(router);
  });

  it('answers the system copy when it is the only one', () => {
    expect(commandPath('gh', { exists: has('/usr/bin/gh') })).toBe('/usr/bin/gh');
  });

  it('looks only in the folders it is given', () => {
    expect(commandPath('adb', { dirs: ['/sdk/platform-tools'], exists: has('/sdk/platform-tools/adb', '/usr/bin/adb') })).toBe(
      '/sdk/platform-tools/adb',
    );
  });

  it('fails naming the command and every folder looked in when none holds it', () => {
    expect(() => commandPath('gh', { dirs: ['/a', '/b'], exists: has() })).toThrow('gh is in none of the fixed folders: /a, /b');
  });
});

describe("npm and npx, run through the running node's own copy", () => {
  it('names the npm and npx scripts beside the running node', () => {
    const lib = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin');
    expect(NPM_CLI).toBe(join(lib, 'npm-cli.js'));
    expect(NPX_CLI).toBe(join(lib, 'npx-cli.js'));
  });
});
