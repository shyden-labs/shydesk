import { describe, it, expect } from 'vitest';
import { FORWARD_PORTS, adbProblem, checkForwards, missingForwards, setForwards, type Adb } from '../e2e/harness/adb-forwards.ts';

const SERIAL = '3b402284';
const BOTH = 'UsbFfs tcp:8765 tcp:8765\nUsbFfs tcp:8787 tcp:8787\n';

/** An adb stand-in that records each call and answers `reverse --list` with `list`. */
function standIn(list: string): { adb: Adb; calls: string[][] } {
  const calls: string[][] = [];
  const adb: Adb = (args) => {
    calls.push([...args]);
    return args.includes('--list') ? list : '';
  };
  return { adb, calls };
}

describe('missingForwards', () => {
  it('finds nothing missing when both ports are forwarded', () => {
    expect(missingForwards(BOTH, FORWARD_PORTS)).toEqual([]);
  });

  it('finds both missing when adb lists no forward', () => {
    expect(missingForwards('', FORWARD_PORTS)).toEqual([8765, 8787]);
  });

  it('finds the one port that is not forwarded', () => {
    expect(missingForwards('UsbFfs tcp:8765 tcp:8765\n', FORWARD_PORTS)).toEqual([8787]);
  });

  it('counts a forward to another port on this Mac as missing', () => {
    expect(missingForwards('UsbFfs tcp:8765 tcp:9000\nUsbFfs tcp:8787 tcp:8787\n', FORWARD_PORTS)).toEqual([8765]);
  });

  it('reads lines ending in a carriage return', () => {
    expect(missingForwards('UsbFfs tcp:8765 tcp:8765\r\nUsbFfs tcp:8787 tcp:8787\r\n', FORWARD_PORTS)).toEqual([]);
  });

  it('does not take a longer port that starts with the same digits', () => {
    expect(missingForwards('UsbFfs tcp:87650 tcp:87650\nUsbFfs tcp:8787 tcp:8787\n', FORWARD_PORTS)).toEqual([8765]);
  });
});

describe('setForwards', () => {
  it('forwards each port on the named phone, then lists them', () => {
    const { adb, calls } = standIn(BOTH);
    setForwards(adb, SERIAL, FORWARD_PORTS);
    expect(calls).toEqual([
      ['-s', SERIAL, 'reverse', 'tcp:8765', 'tcp:8765'],
      ['-s', SERIAL, 'reverse', 'tcp:8787', 'tcp:8787'],
      ['-s', SERIAL, 'reverse', '--list'],
    ]);
  });

  it('returns no problem when the list shows every port', () => {
    expect(setForwards(standIn(BOTH).adb, SERIAL, FORWARD_PORTS)).toBeUndefined();
  });

  it('names the port the list does not show after setting it', () => {
    expect(setForwards(standIn('UsbFfs tcp:8765 tcp:8765\n').adb, SERIAL, FORWARD_PORTS)).toBe(
      `adb reverse --list on ${SERIAL} does not show tcp:8787 just after it was set`,
    );
  });
});

describe('checkForwards', () => {
  const now = new Date('2026-11-16T03:00:00.000Z');

  it('returns no problem and records the time each port was seen', () => {
    const seen = new Map<number, Date>();
    expect(checkForwards(standIn(BOTH).adb, SERIAL, FORWARD_PORTS, seen, now)).toBeUndefined();
    expect([...seen]).toEqual([
      [8765, now],
      [8787, now],
    ]);
  });

  it('only lists, never sets a forward', () => {
    const { adb, calls } = standIn(BOTH);
    checkForwards(adb, SERIAL, FORWARD_PORTS, new Map(), now);
    expect(calls).toEqual([['-s', SERIAL, 'reverse', '--list']]);
  });

  it('names a lost port and the time it was last seen', () => {
    const seen = new Map([
      [8765, new Date('2026-11-16T02:55:00.000Z')],
      [8787, new Date('2026-11-16T02:55:00.000Z')],
    ]);
    expect(checkForwards(standIn('UsbFfs tcp:8765 tcp:8765\n').adb, SERIAL, FORWARD_PORTS, seen, now)).toBe(
      `the Android forward tcp:8787 on ${SERIAL} is gone; last seen 2026-11-16T02:55:00.000Z`,
    );
  });

  it('says a lost port was never seen when no check saw it', () => {
    expect(checkForwards(standIn('').adb, SERIAL, [8765], new Map(), now)).toBe(
      `the Android forward tcp:8765 on ${SERIAL} is gone; last seen never`,
    );
  });

  it('keeps the last-seen time of a lost port', () => {
    const before = new Date('2026-11-16T02:55:00.000Z');
    const seen = new Map([[8787, before]]);
    checkForwards(standIn('UsbFfs tcp:8765 tcp:8765\n').adb, SERIAL, FORWARD_PORTS, seen, now);
    expect(seen.get(8787)).toBe(before);
    expect(seen.get(8765)).toBe(now);
  });
});

describe('adbProblem', () => {
  it('passes on the answer of the check', () => {
    expect(adbProblem(SERIAL, () => 'lost')).toBe('lost');
    expect(adbProblem(SERIAL, () => undefined)).toBeUndefined();
  });

  it('turns adb failing into a problem naming the phone and why', () => {
    const failing = () => {
      throw new Error(`adb: device '${SERIAL}' not found`);
    };
    expect(adbProblem(SERIAL, failing)).toBe(`adb failed on ${SERIAL}: adb: device '${SERIAL}' not found`);
  });
});
