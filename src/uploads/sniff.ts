export type Sniffed = 'jpeg' | 'webp' | 'mp4';

const ascii = (head: Uint8Array, at: number, text: string): boolean => Array.from(text).every((ch, i) => head[at + i] === ch.charCodeAt(0));

/** What a file is by its first bytes, whatever it was called (shyden-labs/shydesk#20). */
export function sniff(head: Uint8Array): Sniffed | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'webp';
  if (ascii(head, 4, 'ftyp')) return 'mp4';
  return null;
}
