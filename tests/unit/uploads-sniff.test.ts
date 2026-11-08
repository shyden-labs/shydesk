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
    expect(await duration(file(ftyp, box('moov', mvhd0(1000, 12_000))))).toBe(12_000);
  });

  it('reads version 1 of the header', async () => {
    expect(await duration(file(ftyp, box('moov', mvhd1(1000, 0, 30_001))))).toBe(30_001);
  });

  it('keeps the high half of a version 1 duration', async () => {
    expect(await duration(file(ftyp, box('moov', mvhd1(1000, 1, 0))))).toBe(2 ** 32);
  });

  it('scales by the timescale', async () => {
    expect(await duration(file(ftyp, box('moov', mvhd0(90_000, 2_700_000))))).toBe(30_000);
  });

  it('finds the header after the media data, with moov at the end', async () => {
    expect(await duration(file(ftyp, box('mdat', new Array<number>(200_000).fill(7)), box('moov', mvhd0(1000, 5_000))))).toBe(5_000);
  });

  it('finds the header after another box inside moov', async () => {
    expect(await duration(file(ftyp, box('moov', [...box('udta', [1, 2, 3]), ...mvhd0(1000, 7_000)])))).toBe(7_000);
  });

  it('follows a 64-bit box size', async () => {
    const mdat = [...u32(1), ...ascii('mdat'), ...u32(0), ...u32(20), 1, 2, 3, 4];
    expect(await duration(file(ftyp, mdat, box('moov', mvhd0(1000, 4_000))))).toBe(4_000);
  });

  it('is null when moov runs past the end of the file', async () => {
    const whole = file(ftyp, box('moov', mvhd0(1000, 4_000)));
    expect(await duration(whole.subarray(0, whole.length - 4))).toBeNull();
  });

  it('is null when moov claims more than the file holds, even with its header intact', async () => {
    const moov = box('moov', mvhd0(1000, 4_000));
    moov[3] = (moov[3] ?? 0) + 100;
    expect(await duration(file(ftyp, moov))).toBeNull();
  });

  it('reads a moov that runs to the end of the file, with a box size of 0', async () => {
    const moov = box('moov', mvhd0(1000, 6_000));
    moov.splice(0, 4, 0, 0, 0, 0);
    expect(await duration(file(ftyp, moov))).toBe(6_000);
  });

  it('is null for a 64-bit box cut off before its size', async () => {
    expect(await duration(file(ftyp, [...u32(1), ...ascii('mdat')]))).toBeNull();
  });

  it('gives up on a moov of endless tiny boxes', async () => {
    const many = Array.from({ length: 100 }, () => box('free', [])).flat();
    expect(await duration(file(ftyp, box('moov', [...many, ...mvhd0(1000, 1_000)])))).toBeNull();
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
    expect(await duration(file(ftyp, box('moov', mvhd0(0, 5_000))))).toBeNull();
  });

  it('is null for a zero duration, which proves no length', async () => {
    expect(await duration(file(ftyp, box('moov', mvhd0(1000, 0))))).toBeNull();
  });

  it('gives up on a file of endless tiny boxes', async () => {
    const many = Array.from({ length: 100 }, () => box('free', []));
    expect(await duration(file(...many, box('moov', mvhd0(1000, 1_000))))).toBeNull();
  });
});
