// `cloudflare:workers` is declared only in @cloudflare/workers-types' global
// form; this project imports the module form, which names the same classes
// under CloudflareWorkersModule. The unit suite aliases the module to
// tests/unit/cloudflare-workers-stand-in.ts.
declare module 'cloudflare:workers' {
  import type { CloudflareWorkersModule } from '@cloudflare/workers-types';
  export const DurableObject: typeof CloudflareWorkersModule.DurableObject;
  export type DurableObject<Env = unknown> = CloudflareWorkersModule.DurableObject<Env>;
}
