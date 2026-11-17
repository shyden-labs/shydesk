import { driver } from './driver.ts';
import { JOURNEY_WAIT, named } from './find.ts';

/**
 * What the journey reads from a video before judging it (shyden-labs/shydesk#188). `paused` turns
 * false the moment play is asked for, before any data has loaded, so "playing" waits for time to
 * move and the size is read only once the metadata has loaded. Every failure names the whole state.
 */
export interface VideoState {
  readyState: number;
  networkState: number;
  paused: boolean;
  currentTime: number;
  width: number;
  height: number;
  /** The MediaError code, or null when there is none. */
  error: number | null;
}

const READY = ['nothing', 'metadata', 'current data', 'future data', 'enough data'];
const NETWORK = ['empty', 'idle', 'loading', 'no source'];
const ERRORS = ['', 'aborted', 'network', 'decode', 'source not supported'];

/** True once the metadata has loaded and the size reads above 0. */
export const sizeKnown = (s: VideoState): boolean => s.readyState >= 1 && s.width > 0 && s.height > 0;

/** True once play was asked for and time has moved. */
export const playing = (s: VideoState): boolean => !s.paused && s.currentTime > 0;

/** The video named `label` and its whole state, with the browser meaning of each number. */
export function videoStateNote(label: string, s: VideoState): string {
  const error = s.error === null ? 'none' : `${String(s.error)} (${ERRORS[s.error] ?? 'unknown'})`;
  return [
    `"${label}": readyState ${String(s.readyState)} (${READY[s.readyState] ?? 'unknown'})`,
    `networkState ${String(s.networkState)} (${NETWORK[s.networkState] ?? 'unknown'})`,
    s.paused ? 'paused' : 'playing asked',
    `time ${s.currentTime.toFixed(2)} s`,
    `size ${String(s.width)}×${String(s.height)}`,
    `error ${error}`,
  ].join(', ');
}

/** Reads the state of the video named `label` from the page. */
export async function videoState(label: string): Promise<VideoState> {
  return driver().execute<VideoState>(
    'const v = arguments[0]; return { readyState: v.readyState, networkState: v.networkState, paused: v.paused, currentTime: v.currentTime, width: v.videoWidth, height: v.videoHeight, error: v.error ? v.error.code : null };',
    await named(label),
  );
}

/** Waits until `holds` is true of the video named `label`, failing with `what` and its last state. */
export async function untilVideo(label: string, holds: (s: VideoState) => boolean, what: string): Promise<VideoState> {
  let last: VideoState | undefined;
  try {
    await driver().waitUntil(
      async () => {
        last = await videoState(label);
        return holds(last);
      },
      { timeout: JOURNEY_WAIT, timeoutMsg: what },
    );
  } catch (error) {
    throw new Error(`${what}: ${last === undefined ? `"${label}" was never read` : videoStateNote(label, last)}`, { cause: error });
  }
  return last as VideoState;
}
