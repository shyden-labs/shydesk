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

/** More tracks than any phone video has; a `moov` with more boxes is refused, not walked. */
const MAX_CHILDREN = 32;
/** How far a track may run from the movie's own length before the file is said to disagree with itself. */
const AGREE_MS = 1000;

/**
 * Timescale and duration from an `mvhd` or `mdhd` payload (the two share
 * their layout), version 0 and 1; null if it is cut short or proves no length.
 */
function scaled(payload: Uint8Array): { timescale: number; duration: number } | null {
  const version = payload[0];
  if (payload.length < (version === 1 ? 32 : 20)) return null;
  const v = view(payload);
  const timescale = v.getUint32(version === 1 ? 20 : 12);
  const duration = version === 1 ? v.getUint32(24) * 2 ** 32 + v.getUint32(28) : v.getUint32(16);
  if (timescale === 0 || duration === 0) return null;
  return { timescale, duration };
}

/** A `tkhd` payload's duration, in the movie's timescale, version 0 and 1; null if cut short. */
function tkhdDuration(payload: Uint8Array): number | null {
  const version = payload[0];
  if (payload.length < (version === 1 ? 36 : 24)) return null;
  const v = view(payload);
  return version === 1 ? v.getUint32(28) * 2 ** 32 + v.getUint32(32) : v.getUint32(20);
}

/** The boxes directly inside `bytes`, or null if any is cut short or there are too many. */
function children(bytes: Uint8Array): (Box & { body: Uint8Array })[] | null {
  const found: (Box & { body: Uint8Array })[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (found.length === MAX_CHILDREN) return null;
    const box = boxAt(bytes.subarray(at, at + 16), at, bytes.length);
    if (!box) return null;
    found.push({ ...box, body: bytes.subarray(box.payload, box.end) });
    at = box.end;
  }
  return found;
}

const first = (boxes: (Box & { body: Uint8Array })[], type: string): Uint8Array | null => boxes.find((b) => b.type === type)?.body ?? null;

/** A track's lengths in ms: its header's (in the movie's timescale) and its media's; null if either is missing. */
function trackLengths(trak: Uint8Array, movieTimescale: number): number[] | null {
  const parts = children(trak);
  const header = parts && first(parts, 'tkhd');
  const media = parts && first(parts, 'mdia');
  const mediaParts = media && children(media);
  const mediaHeader = mediaParts && first(mediaParts, 'mdhd');
  const headerDuration = header && tkhdDuration(header);
  const mediaLength = mediaHeader && scaled(mediaHeader);
  if (headerDuration === null || !mediaLength) return null;
  return [(headerDuration * 1000) / movieTimescale, (mediaLength.duration * 1000) / mediaLength.timescale];
}

/**
 * The movie's length from `moov/mvhd`, checked against every track's own
 * lengths (shyden-labs/shydesk#86): a file whose tracks run more than a
 * second from the movie, or whose track headers are missing or cut short,
 * proves no length. Otherwise the longest of them all.
 */
function inMoov(moov: Uint8Array): number | null {
  const boxes = children(moov);
  const movieHeader = boxes && first(boxes, 'mvhd');
  const movie = movieHeader && scaled(movieHeader);
  if (!boxes || !movie) return null;
  const movieMs = (movie.duration * 1000) / movie.timescale;
  const lengths = [movieMs];
  for (const trak of boxes.filter((b) => b.type === 'trak')) {
    const track = trackLengths(trak.body, movie.timescale);
    if (track === null) return null;
    lengths.push(...track);
  }
  if (lengths.some((ms) => Math.abs(ms - movieMs) > AGREE_MS)) return null;
  return Math.round(Math.max(...lengths));
}

/**
 * A video's length in milliseconds, from its container's `moov`
 * (shyden-labs/shydesk#20, shyden-labs/shydesk#86). It walks the top-level
 * boxes by their sizes to the end of the file, so `moov` is found wherever it
 * sits and the media data is never read. Null when the length cannot be
 * proven: no `moov` or a second one, a cut-short box, a zero duration, or
 * tracks that disagree with the movie.
 */
export async function mp4DurationMs(read: ReadRange, size: number): Promise<number | null> {
  let at = 0;
  let found: number | null = null;
  let moovs = 0;
  for (let n = 0; n < MAX_BOXES && at < size; n += 1) {
    const box = boxAt(await read(at, Math.min(16, size - at)), at, size);
    if (!box) return null;
    if (box.type === 'moov') {
      moovs += 1;
      if (moovs > 1) return null;
      found = inMoov(await read(box.payload, Math.min(box.end - box.payload, MOOV_SEARCH_BYTES)));
      if (found === null) return null;
    }
    at = box.end;
  }
  return at < size ? null : found;
}
