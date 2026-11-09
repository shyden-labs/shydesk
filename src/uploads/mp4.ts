/** Reads up to `length` bytes of the file from `offset`. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/** More top-level boxes than any real MP4 has; a file with more is refused, not walked. */
const MAX_BOXES = 32;
/** The biggest `moov` read; far beyond the sample tables of any 30 s phone video. */
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

/**
 * The only boxes `moov` may hold (shyden-labs/shydesk#106): anything else,
 * such as a compressed movie (`cmov`) or a fragmented one's `mvex`, is a box
 * this check does not read, so the file is refused rather than half-read.
 */
const MOVIE_BOXES = new Set(['mvhd', 'trak', 'udta', 'meta', 'free', 'skip', 'iods']);

/** Top-level boxes of a fragmented file, whose media lies outside `moov`'s tables: refused. */
const FRAGMENTS = new Set(['moof', 'mfra']);

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

/** The one box of `type`; null when there is none or more than one, so a decoy copy can never hide the real one. */
function only(boxes: (Box & { body: Uint8Array })[], type: string): Uint8Array | null {
  const [one, ...more] = boxes.filter((b) => b.type === type);
  return one !== undefined && more.length === 0 ? one.body : null;
}

/** A sample table's sample count and total length (in the media's timescale); null if cut short. */
function sttsTotal(payload: Uint8Array): { count: number; length: number } | null {
  if (payload.length < 8) return null;
  const v = view(payload);
  const entries = v.getUint32(4);
  if (payload.length < 8 + entries * 8) return null;
  let count = 0;
  let length = 0;
  for (let i = 0; i < entries; i += 1) {
    const samples = v.getUint32(8 + i * 8);
    count += samples;
    length += samples * v.getUint32(12 + i * 8);
  }
  return { count, length };
}

/** The largest composition offset in a `ctts` (signed in version 1), in the media's timescale; null if cut short. */
function largestOffset(payload: Uint8Array): number | null {
  if (payload.length < 8) return null;
  const v = view(payload);
  const signed = payload[0] === 1;
  const entries = v.getUint32(4);
  if (payload.length < 8 + entries * 8) return null;
  let largest = 0;
  for (let i = 0; i < entries; i += 1) {
    const at = 12 + i * 8;
    largest = Math.max(largest, signed ? v.getInt32(at) : v.getUint32(at));
  }
  return largest;
}

/** A track's composition offsets' largest, or 0 with none; null when repeated or cut short. */
function offsetsLargest(tableParts: (Box & { body: Uint8Array })[]): number | null {
  const offsets = tableParts.filter((b) => b.type === 'ctts');
  if (offsets.length === 0) return 0;
  const one = only(tableParts, 'ctts');
  return one && largestOffset(one);
}

/** How many samples a sample size table holds; null if cut short. */
function stszCount(payload: Uint8Array): number | null {
  return payload.length < 12 ? null : view(payload).getUint32(8);
}

/** An edit list's total length, in the movie's timescale, version 0 and 1; null if cut short. */
function elstTotal(payload: Uint8Array): number | null {
  if (payload.length < 8) return null;
  const v = view(payload);
  const wide = payload[0] === 1;
  const size = wide ? 20 : 12;
  const entries = v.getUint32(4);
  if (payload.length < 8 + entries * size) return null;
  let total = 0;
  for (let i = 0; i < entries; i += 1) {
    const at = 8 + i * size;
    total += wide ? v.getUint32(at) * 2 ** 32 + v.getUint32(at + 4) : v.getUint32(at);
  }
  return total;
}

/**
 * A track's edits' total length in the movie's timescale: undefined when it
 * has none, null when they are repeated, missing or cut short.
 */
function editsTotal(parts: (Box & { body: Uint8Array })[]): number | null | undefined {
  const lists = parts.filter((b) => b.type === 'edts');
  if (lists.length === 0) return undefined;
  const editParts = only(parts, 'edts');
  const inside = editParts && children(editParts);
  const list = inside && only(inside, 'elst');
  return list && elstTotal(list);
}

/**
 * A track's lengths in ms: its header's (in the movie's timescale), its
 * media's, its samples' (players time a track by these) and its edits'; null
 * if any is missing, repeated or cut short, or the samples timed are not the
 * samples held.
 */
function trackLengths(trak: Uint8Array, movieTimescale: number): number[] | null {
  const parts = children(trak);
  const header = parts && only(parts, 'tkhd');
  const media = parts && only(parts, 'mdia');
  const mediaParts = media && children(media);
  const mediaHeader = mediaParts && only(mediaParts, 'mdhd');
  const info = mediaParts && only(mediaParts, 'minf');
  const infoParts = info && children(info);
  const table = infoParts && only(infoParts, 'stbl');
  const tableParts = table && children(table);
  const timing = tableParts && only(tableParts, 'stts');
  const sizes = tableParts && only(tableParts, 'stsz');
  const headerDuration = header && tkhdDuration(header);
  const mediaLength = mediaHeader && scaled(mediaHeader);
  const samples = timing && sttsTotal(timing);
  const held = sizes && stszCount(sizes);
  const edits = parts && editsTotal(parts);
  const shift = tableParts && offsetsLargest(tableParts);
  // The sample table must time exactly the samples the track holds, or a player may time the rest its own way.
  if (headerDuration === null || !mediaLength || !samples || held !== samples.count || edits === null) return null;
  const perMs = 1000 / mediaLength.timescale;
  // Composition offsets move frames later than the sample table times them: more than a second is refused.
  if (shift === null || shift * perMs > AGREE_MS) return null;
  const lengths = [(headerDuration * 1000) / movieTimescale, mediaLength.duration * perMs, samples.length * perMs];
  if (edits !== undefined) lengths.push((edits * 1000) / movieTimescale);
  return lengths;
}

/**
 * The movie's length from `moov/mvhd`, checked against every track's own
 * lengths (shyden-labs/shydesk#86): a file whose tracks run more than a
 * second from the movie, or whose track headers are missing or cut short,
 * proves no length. Otherwise the longest of them all.
 */
function inMoov(moov: Uint8Array): number | null {
  const boxes = children(moov);
  const movieHeader = boxes && only(boxes, 'mvhd');
  const movie = movieHeader && scaled(movieHeader);
  // A fragmented movie (mvex) carries media outside these tables, so its length is not proven here.
  if (!boxes || !movie || boxes.some((b) => !MOVIE_BOXES.has(b.type))) return null;
  // A movie with nothing to play proves no length (shyden-labs/shydesk#106).
  if (!boxes.some((b) => b.type === 'trak')) return null;
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
    if (!box || FRAGMENTS.has(box.type)) return null;
    if (box.type === 'moov') {
      moovs += 1;
      // A moov too big to read whole could hide a track past what is read, so it proves no length.
      if (moovs > 1 || box.end - box.payload > MOOV_SEARCH_BYTES) return null;
      found = inMoov(await read(box.payload, box.end - box.payload));
      if (found === null) return null;
    }
    at = box.end;
  }
  return at < size ? null : found;
}
