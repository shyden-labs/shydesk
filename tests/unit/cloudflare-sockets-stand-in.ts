// `cloudflare:sockets` exists only inside the Workers runtime; the unit suite
// aliases it here (vitest.unit.config.ts). No unit test reaches the network:
// `connect` records what it was asked for and refuses.
export const connections: { address: unknown; options: unknown }[] = [];

export function connect(address: unknown, options: unknown): never {
  connections.push({ address, options });
  throw new Error('no sockets in the unit suite');
}
