/** Reads up to `length` bytes of the file from `offset`. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/** More top-level boxes than any real MP4 has; a file with more is refused, not walked. */
const MAX_BOXES = 32;
/** How much of `moov` is searched for `mvhd`, which real files put at or near its start. */
const MOOV_SEARCH_BYTES = 1024 * 1024;

interface Box {
  type: string;
  /** Where the box's payload starts, from the start of what was read. */
  payload: number;
  end: number;
}

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The box whose header is at the start of `header`, or null if no valid box is there. */
function boxAt(header: Uint8Array, at: number, limit: number): Box | null {
  if (header.length < 8) return null;
  const v = view(header);
  const type = String.fromCharCode(...header.subarray(4, 8));
  const short = v.getUint32(0);
  if (short === 1 && header.length < 16) return null;
  const headerSize = short === 1 ? 16 : 8;
  let size = short;
  if (short === 1) size = v.getUint32(8) * 2 ** 32 + v.getUint32(12);
  if (short === 0) size = limit - at;
  const end = at + size;
  if (size < headerSize || end > limit) return null;
  return { type, payload: at + headerSize, end };
}

/** Length from an `mvhd` payload, version 0 and 1; null if it is cut short or proves no length. */
function fromMvhd(payload: Uint8Array): number | null {
  const version = payload[0];
  if (payload.length < (version === 1 ? 32 : 20)) return null;
  const v = view(payload);
  const timescale = v.getUint32(version === 1 ? 20 : 12);
  const duration = version === 1 ? v.getUint32(24) * 2 ** 32 + v.getUint32(28) : v.getUint32(16);
  if (timescale === 0 || duration === 0) return null;
  return Math.round((duration * 1000) / timescale);
}

function inMoov(moov: Uint8Array): number | null {
  let at = 0;
  for (let n = 0; n < MAX_BOXES; n += 1) {
    const box = boxAt(moov.subarray(at, at + 16), at, moov.length);
    if (!box) return null;
    if (box.type === 'mvhd') return fromMvhd(moov.subarray(box.payload, box.end));
    at = box.end;
  }
  return null;
}

/**
 * A video's length in milliseconds, from its container's `moov/mvhd`
 * (shyden-labs/shydesk#20). It walks the top-level boxes by their sizes, so
 * `moov` is found wherever it sits and the media data is never read. Null when
 * the length cannot be proven: no `moov`, a cut-short box or a zero duration.
 */
export async function mp4DurationMs(read: ReadRange, size: number): Promise<number | null> {
  let at = 0;
  for (let n = 0; n < MAX_BOXES; n += 1) {
    const box = boxAt(await read(at, Math.min(16, size - at)), at, size);
    if (!box) return null;
    if (box.type === 'moov') return inMoov(await read(box.payload, Math.min(box.end - box.payload, MOOV_SEARCH_BYTES)));
    at = box.end;
    if (at >= size) return null;
  }
  return null;
}
