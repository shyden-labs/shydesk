/**
 * ShyDesk's dev Worker opens only to a DEV pass (shyden-labs/shydesk#302, global rule of
 * 2026-11-22, shyden-labs/repo-template#207). With no DEV_PASS_HOST (live, TEST) every request
 * goes straight to the app. On dev, the shared door checks every request except the open paths:
 * the deploy read-back and the public embed scripts, which a `<script>` tag or `import()` loads
 * with no way to send a pass, and whose content is this public repository's code.
 */
import { handleDevDoor, type DoorEnv } from './door.ts';
import type { PublicKeys } from './pass.ts';

export interface GateEnv {
  /** This Worker's own host, which every pass must name as `aud`. Set on dev alone. */
  DEV_PASS_HOST?: string;
  /** The sign-in's public keys as JSON, `{ "<kid>": "<Ed25519 JWK x>" }`. */
  DEV_PASS_KEYS?: string;
  /** The dev product pages whose embeds may call with an embed pass, as a JSON array. */
  DEV_PASS_EMBED_ORIGINS?: string;
}

export const OPEN_PATHS: readonly string[] = [
  '/health',
  '/embed.js',
  '/embed-media.js',
  '/embed-viewer.js',
  '/embed-video.js',
  '/embed-video-LICENSE.txt',
  '/embed-video-NOTICE.txt',
];

/** The value of `text` as JSON when `accepts` it, else undefined. */
function parsed<T>(text: string | undefined, accepts: (value: unknown) => value is T): T | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return accepts(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const isKeys = (value: unknown): value is PublicKeys =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((x) => typeof x === 'string');

const isOrigins = (value: unknown): value is string[] => Array.isArray(value) && value.every((origin) => typeof origin === 'string');

function broken(name: string): Response {
  return new Response(`The DEV door's ${name} setting is missing or malformed.`, { status: 500, headers: { 'cache-control': 'no-store' } });
}

/** `request` answered through the DEV door when `env` sets one; `now` is seconds since the epoch. */
export function gatedFetch(
  request: Request,
  env: GateEnv,
  forward: (request: Request) => Promise<Response>,
  now: number,
): Promise<Response> {
  const host = env.DEV_PASS_HOST;
  if (host === undefined || OPEN_PATHS.includes(new URL(request.url).pathname)) return forward(request);
  const keys = parsed(env.DEV_PASS_KEYS, isKeys);
  if (keys === undefined) return Promise.resolve(broken('DEV_PASS_KEYS'));
  const embedOrigins = parsed(env.DEV_PASS_EMBED_ORIGINS, isOrigins);
  if (embedOrigins === undefined) return Promise.resolve(broken('DEV_PASS_EMBED_ORIGINS'));
  const door: DoorEnv = { host, keys, now, embedOrigins };
  return handleDevDoor(request, door, forward);
}
