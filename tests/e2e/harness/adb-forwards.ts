/**
 * Android reads the suite's pages on localhost through `adb reverse`
 * (shyden-labs/shydesk#21). On 2026-11-15 the forwards vanished between two
 * runs for a reason never found, and the next runs failed later with a bare
 * connection refused (shyden-labs/shydesk#153). So the run sets them itself,
 * checks adb lists them, and checks again after each Android spec, naming the
 * lost port and when it was last seen.
 */

/** The suite's pages (8765) and the local ShyDesk (8787). */
export const FORWARD_PORTS: readonly number[] = [8765, 8787];

/** Runs adb with these arguments and returns what it printed. */
export type Adb = (args: readonly string[]) => string;

const forward = (port: number): string => `tcp:${String(port)}`;

/**
 * The ports in `ports` that `adb reverse --list` output does not forward to
 * the same port on this Mac. Each line reads `<transport> <phone> <mac>`.
 */
export function missingForwards(list: string, ports: readonly number[]): number[] {
  const listed = new Set(
    list
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((words) => words.length === 3 && words[1] === words[2])
      .map((words) => words[1]),
  );
  return ports.filter((port) => !listed.has(forward(port)));
}

/** Forwards each port on the phone, then lists them: a port adb does not show is the problem returned. */
export function setForwards(adb: Adb, serial: string, ports: readonly number[]): string | undefined {
  for (const port of ports) adb(['-s', serial, 'reverse', forward(port), forward(port)]);
  const missing = missingForwards(adb(['-s', serial, 'reverse', '--list']), ports);
  if (missing.length === 0) return undefined;
  return `adb reverse --list on ${serial} does not show ${missing.map(forward).join(', ')} just after it was set`;
}

/**
 * Lists the phone's forwards without setting any: each port seen gets `now`
 * in `seen`, and a lost one is the problem returned, with its last-seen time.
 */
export function checkForwards(adb: Adb, serial: string, ports: readonly number[], seen: Map<number, Date>, now: Date): string | undefined {
  const missing = missingForwards(adb(['-s', serial, 'reverse', '--list']), ports);
  for (const port of ports) if (!missing.includes(port)) seen.set(port, now);
  if (missing.length === 0) return undefined;
  return missing
    .map((port) => `the Android forward ${forward(port)} on ${serial} is gone; last seen ${seen.get(port)?.toISOString() ?? 'never'}`)
    .join('\n');
}

/** The check's answer, or adb failing (no phone, wrong serial) as a problem naming the phone and why. */
export function adbProblem(serial: string, check: () => string | undefined): string | undefined {
  try {
    return check();
  } catch (error) {
    return `adb failed on ${serial}: ${(error as Error).message}`;
  }
}
