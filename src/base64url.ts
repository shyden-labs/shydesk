/** Bytes as base64url: `-` and `_` in place of `+` and `/`, with no `=` padding. */
export function base64url(bytes: Uint8Array): string {
  const padded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  let end = padded.length;
  while (padded[end - 1] === '=') end -= 1;
  return padded.slice(0, end);
}
