import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mp4DurationMs, type ReadRange } from '../../src/uploads/mp4.ts';
import { sniff } from '../../src/uploads/sniff.ts';

// The server decides what a file is by its content, never its name, and reads a
// video's length from its container (shyden-labs/shydesk#20 AC2).
const media = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/media/${name}`, import.meta.url)));
const upload = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/uploads/${name}`, import.meta.url)));

const reader =
  (bytes: Uint8Array): ReadRange =>
  (offset, length) =>
    Promise.resolve(bytes.subarray(offset, offset + length));

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => Array.from(s, (ch) => ch.charCodeAt(0));
const box = (type: string, payload: number[]): number[] => [...u32(payload.length + 8), ...ascii(type), ...payload];
const mvhd0 = (timescale: number, duration: number): number[] =>
  box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration)]);
const mvhd1 = (timescale: number, hi: number, lo: number): number[] =>
  box('mvhd', [1, 0, 0, 0, ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(timescale), ...u32(hi), ...u32(lo)]);
const ftyp = box('ftyp', ascii('isom'));
// A track's header (`tkhd`, in the movie's timescale) and its media header (`mdhd`, in its own), as `trak/tkhd` and
// `trak/mdia/mdhd` (shyden-labs/shydesk#86).
const tkhd0 = (duration: number): number[] => box('tkhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(duration)]);
const tkhd1 = (hi: number, lo: number): number[] =>
  box('tkhd', [1, 0, 0, 0, ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(hi), ...u32(lo)]);
const mdhd0 = (timescale: number, duration: number): number[] =>
  box('mdhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration)]);
const mdhd1 = (timescale: number, hi: number, lo: number): number[] =>
  box('mdhd', [1, 0, 0, 0, ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(timescale), ...u32(hi), ...u32(lo)]);
/** A sample table: each entry is [sample count, sample length in the media's timescale]. */
const stts = (...entries: [number, number][]): number[] =>
  box('stts', [0, 0, 0, 0, ...u32(entries.length), ...entries.flatMap(([count, delta]) => [...u32(count), ...u32(delta)])]);
/** The duration an `mdhd` built above states (version 0, or version 1's low half). */
const statedBy = (mdhd: number[]): number => {
  const at = mdhd[8] === 1 ? 36 : 24;
  return new DataView(new Uint8Array(mdhd).buffer).getUint32(at);
};
/** A sample size table holding `count` samples of one size. */
const stsz = (count: number): number[] => box('stsz', [0, 0, 0, 0, ...u32(1), ...u32(count)]);
/** How many samples an `stts` built above lists. */
const sampleCount = (table: number[]): number => {
  const v = new DataView(new Uint8Array(table).buffer);
  let total = 0;
  // A deliberately cut-short table counts only the entries it holds.
  for (let at = 16; table.length >= 16 && at + 4 <= table.length; at += 8) total += v.getUint32(at);
  return total;
};
/** An edit list (version 0): each entry is [length in the movie's timescale, media time]; rate 1. */
const elst = (...edits: [number, number][]): number[] =>
  box('elst', [0, 0, 0, 0, ...u32(edits.length), ...edits.flatMap(([length, from]) => [...u32(length), ...u32(from >>> 0), 0, 1, 0, 0])]);
/**
 * A track: header, any edit list, then media with its sample table, which by default adds up to what the `mdhd`
 * states, and a size table listing as many samples as the sample table does.
 */
const trak = (
  header: number[],
  media: number[],
  samples: number[] = stts([1, statedBy(media)]),
  options: { sizes?: number[]; edits?: number[] } = {},
): number[] =>
  box('trak', [
    ...header,
    ...(options.edits === undefined ? [] : box('edts', options.edits)),
    ...box('mdia', [...media, ...box('minf', box('stbl', [...samples, ...(options.sizes ?? stsz(sampleCount(samples)))]))]),
  ]);

/**
 * A movie of one track that agrees with its header: what a real file holds,
 * so a test about something else is not refused for having no track
 * (shyden-labs/shydesk#106). `extra` boxes go first inside moov.
 */
const movie = (header: number[], ...extra: number[][]): number[] => {
  const v = new DataView(new Uint8Array(header).buffer);
  const wide = header[8] === 1;
  const timescale = v.getUint32(wide ? 28 : 20);
  const hi = wide ? v.getUint32(32) : 0;
  const lo = v.getUint32(wide ? 36 : 24);
  const samples: [number, number][] = hi > 0 ? [[hi * 2, 2 ** 31]] : [[1, lo]];
  if (hi > 0 && lo > 0) samples.push([1, lo]);
  const track = trak(hi > 0 ? tkhd1(hi, lo) : tkhd0(lo), wide ? mdhd1(timescale, hi, lo) : mdhd0(timescale, lo), stts(...samples));
  return box('moov', [...extra.flat(), ...header, ...track]);
};
const file = (...boxes: number[][]): Uint8Array => new Uint8Array(boxes.flat());
const duration = (bytes: Uint8Array): Promise<number | null> => mp4DurationMs(reader(bytes), bytes.length);

describe('sniff', () => {
  it('names a JPEG', () => {
    expect(sniff(media('photo.jpg').subarray(0, 64))).toBe('jpeg');
  });

  it('names a WebP', () => {
    expect(sniff(upload('photo.webp').subarray(0, 64))).toBe('webp');
  });

  it('names an MP4', () => {
    expect(sniff(media('ok-10s.mp4').subarray(0, 64))).toBe('mp4');
  });

  it('refuses text with an mp4 name', () => {
    expect(sniff(upload('fake.mp4'))).toBeNull();
  });

  it('refuses a RIFF file that is not WebP', () => {
    expect(sniff(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(sniff(new Uint8Array())).toBeNull();
  });
});

describe('mp4DurationMs', () => {
  it('reads about 10 s from the 10 s fixture', async () => {
    const ms = await duration(media('ok-10s.mp4'));
    expect(ms).toBeGreaterThan(9_500);
    expect(ms).toBeLessThan(10_500);
  });

  it('reads about 45 s from the 45 s fixture', async () => {
    const ms = await duration(media('long-45s.mp4'));
    expect(ms).toBeGreaterThan(44_500);
    expect(ms).toBeLessThan(45_500);
  });

  it('reads version 0 of the header', async () => {
    expect(await duration(file(ftyp, movie(mvhd0(1000, 12_000))))).toBe(12_000);
  });

  it('reads version 1 of the header', async () => {
    expect(await duration(file(ftyp, movie(mvhd1(1000, 0, 30_001))))).toBe(30_001);
  });

  it('keeps the high half of a version 1 duration', async () => {
    expect(await duration(file(ftyp, movie(mvhd1(1000, 1, 0))))).toBe(2 ** 32);
  });

  it('scales by the timescale', async () => {
    expect(await duration(file(ftyp, movie(mvhd0(90_000, 2_700_000))))).toBe(30_000);
  });

  it('finds the header after the media data, with moov at the end', async () => {
    expect(await duration(file(ftyp, box('mdat', new Array<number>(200_000).fill(7)), movie(mvhd0(1000, 5_000))))).toBe(5_000);
  });

  it('finds the header after another box inside moov', async () => {
    expect(await duration(file(ftyp, movie(mvhd0(1000, 7_000), box('udta', [1, 2, 3]))))).toBe(7_000);
  });

  it('follows a 64-bit box size', async () => {
    const mdat = [...u32(1), ...ascii('mdat'), ...u32(0), ...u32(20), 1, 2, 3, 4];
    expect(await duration(file(ftyp, mdat, movie(mvhd0(1000, 4_000))))).toBe(4_000);
  });

  it('is null when moov runs past the end of the file', async () => {
    const whole = file(ftyp, movie(mvhd0(1000, 4_000)));
    expect(await duration(whole.subarray(0, whole.length - 4))).toBeNull();
  });

  it('is null when moov claims more than the file holds, even with its header intact', async () => {
    const moov = movie(mvhd0(1000, 4_000));
    moov[3] = (moov[3] ?? 0) + 100;
    expect(await duration(file(ftyp, moov))).toBeNull();
  });

  it('reads a moov that runs to the end of the file, with a box size of 0', async () => {
    const moov = movie(mvhd0(1000, 6_000));
    moov.splice(0, 4, 0, 0, 0, 0);
    expect(await duration(file(ftyp, moov))).toBe(6_000);
  });

  it('is null for a 64-bit box cut off before its size', async () => {
    expect(await duration(file(ftyp, [...u32(1), ...ascii('mdat')]))).toBeNull();
  });

  it('gives up on a moov of endless tiny boxes', async () => {
    const many = Array.from({ length: 100 }, () => box('free', [])).flat();
    expect(await duration(file(ftyp, movie(mvhd0(1000, 1_000), many)))).toBeNull();
  });

  it('is null for a file with no moov', async () => {
    expect(await duration(file(ftyp))).toBeNull();
  });

  it('is null for a box claiming a size below its own header', async () => {
    expect(await duration(new Uint8Array([...u32(4), ...ascii('free'), ...ftyp]))).toBeNull();
  });

  it('is null for moov with no mvhd', async () => {
    expect(await duration(file(ftyp, box('moov', box('udta', [1]))))).toBeNull();
  });

  it('is null for a cut-short mvhd', async () => {
    expect(await duration(file(ftyp, box('moov', box('mvhd', [0, 0, 0, 0, 1, 2]))))).toBeNull();
  });

  it('is null for a zero timescale', async () => {
    expect(await duration(file(ftyp, movie(mvhd0(0, 5_000))))).toBeNull();
  });

  it('is null for a zero duration, which proves no length', async () => {
    expect(await duration(file(ftyp, movie(mvhd0(1000, 0))))).toBeNull();
  });

  // shyden-labs/shydesk#86: every track's own lengths are read too, and a file that disagrees with itself is refused.
  it('gives the longest length when every track agrees with the movie within a second', async () => {
    const moov = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_200), mdhd0(48_000, 48 * 10_100))]);
    expect(await duration(file(ftyp, moov))).toBe(10_200);
  });

  it('refuses a track header that runs over a second past the movie header', async () => {
    const moov = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(45_000), mdhd0(1000, 10_000))]);
    expect(await duration(file(ftyp, moov))).toBeNull();
  });

  it("refuses a track's media running over a second past the movie, in the track's own timescale", async () => {
    const moov = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(90_000, 90 * 45_000))]);
    expect(await duration(file(ftyp, moov))).toBeNull();
  });

  it('refuses a track shorter than the movie by over a second', async () => {
    const moov = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(8_000), mdhd0(1000, 8_000))]);
    expect(await duration(file(ftyp, moov))).toBeNull();
  });

  it('checks every track, not just the first', async () => {
    const ok = trak(tkhd0(10_000), mdhd0(1000, 10_000));
    const moov = box('moov', [...mvhd0(1000, 10_000), ...ok, ...trak(tkhd0(40_000), mdhd0(1000, 40_000))]);
    expect(await duration(file(ftyp, moov))).toBeNull();
  });

  it('reads a track header in the movie timescale, wherever the movie header sits', async () => {
    const moov = box('moov', [...trak(tkhd0(20_000), mdhd0(1000, 10_000)), ...mvhd0(2000, 20_000)]);
    expect(await duration(file(ftyp, moov))).toBe(10_000);
  });

  it('reads version 1 track and media headers, high halves kept', async () => {
    const long = trak(tkhd1(1, 10_000), mdhd1(1000, 0, 10_000));
    expect(await duration(file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...long])))).toBeNull();
    const fine = trak(tkhd1(0, 10_000), mdhd1(1000, 0, 10_000));
    expect(await duration(file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...fine])))).toBe(10_000);
  });

  it('refuses a track whose headers are cut short or missing', async () => {
    const cut = box('tkhd', [0, 0, 0, 0, ...u32(0)]);
    expect(await duration(file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...trak(cut, mdhd0(1000, 10_000))])))).toBeNull();
    const noMedia = box('trak', tkhd0(10_000));
    expect(await duration(file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...noMedia])))).toBeNull();
    const noHeader = box('trak', box('mdia', mdhd0(1000, 10_000)));
    expect(await duration(file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...noHeader])))).toBeNull();
  });

  it('refuses a track whose box runs past the end of moov', async () => {
    const whole = trak(tkhd0(10_000), mdhd0(1000, 10_000));
    const cut = [...u32(whole.length + 50), ...whole.slice(4)];
    expect(await duration(file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...cut])))).toBeNull();
  });

  it('refuses a second moov, whatever it says', async () => {
    const one = movie(mvhd0(1000, 10_000));
    expect(await duration(file(ftyp, one, box('mdat', [1, 2, 3]), one))).toBeNull();
  });

  it('refuses a moov too big to read whole, even when its first MiB ends on a box boundary', async () => {
    const head = new Uint8Array([...ftyp, 0, 0, 0, 0, ...ascii('moov'), ...mvhd0(1000, 10_000)]);
    const track = new Uint8Array(trak(tkhd0(45_000), mdhd0(1000, 45_000)));
    // Padding that ends exactly at 1 MiB into moov, then a 45 s track that a cut-off read would never see.
    const moovStart = ftyp.length;
    const padStart = head.length;
    const padEnd = moovStart + 8 + 1024 * 1024;
    const bytes = new Uint8Array(padEnd + track.length);
    bytes.set(head);
    bytes.set(track, padEnd);
    const v = new DataView(bytes.buffer);
    v.setUint32(moovStart, bytes.length - moovStart);
    v.setUint32(padStart, padEnd - padStart);
    bytes.set(ascii('free'), padStart + 4);
    expect(await duration(bytes)).toBeNull();
  });

  // Security review of shyden-labs/shydesk#86: players time a track by its samples, a repeated header box could
  // hide the real one, and a fragmented file carries media outside moov's tables.
  it('reads a sample table of several entries, in the media timescale', async () => {
    const moov = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(30, 300), stts([299, 1], [1, 400]))]);
    expect(await duration(file(ftyp, moov))).toBeNull();
    const fine = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(30, 300), stts([150, 1], [50, 3]))]);
    expect(await duration(file(ftyp, fine))).toBe(10_000);
  });

  it('refuses samples that run over a second past the media header', async () => {
    const moov = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000), stts([45, 1000]))]);
    expect(await duration(file(ftyp, moov))).toBeNull();
  });

  it('refuses a track with no sample table, or one cut short', async () => {
    const none = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000), box('stsz', []))]);
    expect(await duration(file(ftyp, none))).toBeNull();
    const cut = box('stts', [0, 0, 0, 0, ...u32(2), ...u32(10), ...u32(1000)]);
    const short = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000), cut)]);
    expect(await duration(file(ftyp, short))).toBeNull();
    const stub = box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000), box('stts', [0, 0, 0, 0]))]);
    expect(await duration(file(ftyp, stub))).toBeNull();
  });

  it.each(['mvhd', 'tkhd', 'mdhd', 'stts'])('refuses a repeated %s, whichever copy tells the truth', async (type) => {
    const header = { mvhd: mvhd0(1000, 10_000), tkhd: tkhd0(10_000), mdhd: mdhd0(1000, 10_000), stts: stts([1, 10_000]) }[type] ?? [];
    const twice = (bytes: number[]): number[] => [...bytes, ...header];
    const moovOf = (t: string): number[] => {
      const head = t === 'mvhd' ? twice(mvhd0(1000, 10_000)) : mvhd0(1000, 10_000);
      const track = t === 'tkhd' ? twice(tkhd0(10_000)) : tkhd0(10_000);
      const media = t === 'mdhd' ? twice(mdhd0(1000, 10_000)) : mdhd0(1000, 10_000);
      const samples = t === 'stts' ? twice(stts([1, 10_000])) : stts([1, 10_000]);
      return box('moov', [...head, ...trak(track, media, samples)]);
    };
    expect(await duration(file(ftyp, moovOf('none')))).toBe(10_000);
    expect(await duration(file(ftyp, moovOf(type)))).toBeNull();
  });

  it('refuses a sample table that times fewer or more samples than the track holds', async () => {
    const plain = (sizes: number[]): Uint8Array =>
      file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000), stts([10, 1000]), { sizes })]));
    expect(await duration(plain(stsz(10)))).toBe(10_000);
    expect(await duration(plain(stsz(450)))).toBeNull();
    expect(await duration(plain(stsz(9)))).toBeNull();
    expect(await duration(plain(box('stsz', [0, 0, 0, 0, ...u32(1)])))).toBeNull();
    expect(await duration(plain([...stsz(10), ...stsz(10)]))).toBeNull();
    expect(await duration(plain([]))).toBeNull();
  });

  it('counts an edit list, whose edits can hold or repeat frames, among the lengths that must agree', async () => {
    const edited = (edits: number[]): Uint8Array =>
      file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000), undefined, { edits })]));
    expect(await duration(edited(elst([10_000, 0])))).toBe(10_000);
    expect(await duration(edited(elst([2_000, -1], [8_000, 0])))).toBe(10_000);
    expect(await duration(edited(elst([10_000, 0], [35_000, 0])))).toBeNull();
    expect(await duration(edited(box('elst', [0, 0, 0, 0, ...u32(2), ...u32(10_000)])))).toBeNull();
    expect(await duration(edited([...elst([10_000, 0]), ...elst([10_000, 0])]))).toBeNull();
    expect(await duration(edited([]))).toBeNull();
  });

  it('reads a version 1 edit list, high halves kept', async () => {
    const v1 = (hi: number, lo: number): number[] =>
      box('elst', [1, 0, 0, 0, ...u32(1), ...u32(hi), ...u32(lo), ...u32(0), ...u32(0), 0, 1, 0, 0]);
    const edited = (edits: number[]): Uint8Array =>
      file(ftyp, box('moov', [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000), undefined, { edits })]));
    expect(await duration(edited(v1(0, 10_000)))).toBe(10_000);
    expect(await duration(edited(v1(1, 10_000)))).toBeNull();
    const two = box('elst', [
      1,
      0,
      0,
      0,
      ...u32(2),
      ...[4_000, 6_000].flatMap((lo) => [...u32(0), ...u32(lo), ...u32(0), ...u32(0), 0, 1, 0, 0]),
    ]);
    expect(await duration(edited(two))).toBe(10_000);
  });

  it('refuses a cut-short edit list even on a video shorter than a second', async () => {
    const cut = box('elst', [0, 0, 0, 0, ...u32(2), ...u32(500)]);
    const moov = box('moov', [...mvhd0(1000, 500), ...trak(tkhd0(500), mdhd0(1000, 500), undefined, { edits: cut })]);
    expect(await duration(file(ftyp, moov))).toBeNull();
    const stub = box('elst', [0, 0, 0, 0]);
    const tiny = box('moov', [...mvhd0(1000, 500), ...trak(tkhd0(500), mdhd0(1000, 500), undefined, { edits: stub })]);
    expect(await duration(file(ftyp, tiny))).toBeNull();
  });

  it('refuses a fragmented file: movie extends in moov, or fragments beside it', async () => {
    const plain = [...mvhd0(1000, 10_000), ...trak(tkhd0(10_000), mdhd0(1000, 10_000))];
    expect(await duration(file(ftyp, box('moov', [...plain, ...box('mvex', [])])))).toBeNull();
    expect(await duration(file(ftyp, box('moov', plain), box('moof', [])))).toBeNull();
    expect(await duration(file(ftyp, box('moov', plain), box('mfra', [])))).toBeNull();
  });

  // shyden-labs/shydesk#106: only boxes the check knows may sit in moov, and a movie needs a track.
  it('refuses a movie with no track', async () => {
    expect(await duration(file(ftyp, box('moov', mvhd0(1000, 10_000))))).toBeNull();
  });

  it.each(['udta', 'meta', 'free', 'skip', 'iods'])('accepts a %s box beside the tracks', async (type) => {
    expect(await duration(file(ftyp, movie(mvhd0(1000, 10_000), box(type, [1, 2, 3]))))).toBe(10_000);
  });

  it.each(['cmov', 'mvex', 'xyz1', 'trex'])('refuses a %s box in moov', async (type) => {
    expect(await duration(file(ftyp, movie(mvhd0(1000, 10_000), box(type, [1, 2, 3]))))).toBeNull();
  });

  it('refuses composition offsets past a second, repeated, or cut short; accepts small ones', async () => {
    const ctts = (offsets: number[], version = 0): number[] =>
      box('ctts', [version, 0, 0, 0, ...u32(offsets.length), ...offsets.flatMap((o) => [...u32(1), ...u32(o >>> 0)])]);
    const withOffsets = (extra: number[]): Uint8Array =>
      file(
        ftyp,
        box('moov', [
          ...mvhd0(1000, 10_000),
          ...trak(tkhd0(10_000), mdhd0(1000, 10_000), [...stts([10, 1000]), ...extra], { sizes: stsz(10) }),
        ]),
      );
    expect(await duration(withOffsets(ctts([0, 40, 80])))).toBe(10_000);
    expect(await duration(withOffsets(ctts([0, -40, 80], 1)))).toBe(10_000);
    expect(await duration(withOffsets(ctts([0, 35_000])))).toBeNull();
    expect(await duration(withOffsets([...ctts([40]), ...ctts([40])]))).toBeNull();
    expect(await duration(withOffsets(box('ctts', [0, 0, 0, 0, ...u32(2), ...u32(1)])))).toBeNull();
    expect(await duration(withOffsets(box('ctts', [0, 0, 0, 0])))).toBeNull();
  });

  it('refuses a file with too many boxes after moov to see whether a second one follows', async () => {
    const many = Array.from({ length: 40 }, () => box('free', []));
    expect(await duration(file(ftyp, movie(mvhd0(1000, 10_000)), ...many))).toBeNull();
  });

  it('refuses a file whose boxes stop making sense after moov', async () => {
    expect(await duration(file(ftyp, movie(mvhd0(1000, 10_000)), [0, 0, 0, 2, 9, 9]))).toBeNull();
  });

  it('gives up on a file of endless tiny boxes', async () => {
    const many = Array.from({ length: 100 }, () => box('free', []));
    expect(await duration(file(...many, movie(mvhd0(1000, 1_000))))).toBeNull();
  });
});
