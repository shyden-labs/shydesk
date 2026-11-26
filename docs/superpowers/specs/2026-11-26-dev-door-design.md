# DEV door for DEV passes (shyden-labs/shydesk#302) — design

## Intent
Only holders of a DEV pass signed by the shared sign-in (dev-signin.shyden.co.uk) can use
ShyDesk's DEV (https://shydesk.shydesk-non-prod.workers.dev), per the global rule of
2026-11-22 (shyden-labs/repo-template#207, door pattern shyden-labs/repo-template#209). The dev product pages
(dev.yaweloidle.com, dev.shytalk.app, dev.shyden.co.uk) keep sending support requests to it.

## Goals
- AC1: every request on DEV without a valid pass gets 401 (or the sign-in redirect for a
  page) before any ShyDesk handler runs; unit tests per failure, red first.
- AC2: requests from the three embed origins with a fresh `embed` pass are accepted; CORS
  allows `X-Dev-Pass` from those origins only.
- AC3: PROD and TEST have no gate; pinned by a test of wrangler.jsonc.

## Non-goals
Changing Cloudflare Access on staff paths; the sign-in itself (shyden.co.uk#1292).

## Anti-goals
- The door's embed list widening ShyDesk's per-product allowed origins: both checks run,
  the door first, and a request must pass both.
- A shared password or secret in any build.
- Breaking shyden.co.uk's per-deploy dev journey (shyden-labs/shydesk#254) without warning.

## Constraints
- Copy `scripts/dev-pass/door.ts` and `pass.ts` from shyden-labs/repo-template at a named
  SHA (never import across repos); record the SHA in the file header.
- aud = `shydesk.shydesk-non-prod.workers.dev`; keys `{ "2026-11": "OBLprb_S4Kn2C--HFVaeA3_s6gEsApDiRAWPLc6WsK8" }`
  as public vars on env.dev only.
- The email() handler (Email Routing, shyden-labs/shydesk#232) is not a fetch and stays untouched.

## Approaches
1. **Door inside the dev Worker's fetch (chosen).** `fetch` = `handleDevDoor(req, env, app.fetch)`
   when `DEV_PASS_KEYS` is set, else `app.fetch`. One Worker, aud is its own host.
2. Separate door Worker in front, on a `dev.` custom domain. Needs a domain ShyDesk's DEV
   does not use (it answers on workers.dev by the 2026-11-04 ruling: no domain), and
   moves every embed URL. Rejected.
3. Hono middleware re-implementing the check. Diverges from the shared door code. Rejected.

## Decided (builder's calls, stated)
- **Paths outside the door:** `/health` (deploy read-back, no data) and the public static
  scripts `/embed.js`, `/embed-media.js`, `/embed-viewer.js` and the video tools: a `<script>`
  tag or `import()` cannot carry a header, and their content is the public repo's code. Every
  other path, staff included, is behind the door; Access stays behind it (decided on shyden-labs/shydesk#302,
  2026-11-26, from the rule's "before it serves anything").
- **How embed.js gets a pass:** when its own HOST is the dev host (one constant), before its
  first ShyDesk call it posts to `<page origin>/__devpass/embed?for=<dev host>` (same-origin
  credentials), keeps the pass in memory, sends `X-Dev-Pass` on every call, and on a 401
  with an empty body (the door's refusal) asks for one new pass once, as repo-template's
  documented protocol says (a 5-minute pass expiring, not a retry of a failure). A second
  401 shows the plain failure line. Live and TEST builds never call `/__devpass`.
- **Machines:** every machine caller (shyden.co.uk's per-deploy journey shyden-labs/shydesk#254, product dev
  servers calling `/api`) takes a 1-hour machine pass from the sign-in's `/machine` with its
  own service token and sends it as `X-Dev-Pass`. ShyDesk's own CI calls no deployed dev
  (measured 2026-11-26: no workflow or script names the dev host), so no door secret exists:
  repo-template's step 5 secret is for an origin behind a separate door, and here the door
  forwards in-process. The copy drops `secretHeader`/`secret` and says why in its header.
  Each caller's session is told before the door ships, with the date.
- **Callers measured before shipping:** dev D1 `products.allowed_origins_json` and the API
  keys in use; each caller is named on shyden-labs/shydesk#302 with what it needs.

## Left to the builder
File layout under `src/dev-door/`, test names, the order of the plan's tasks.

## Open (outside)
The sign-in is not deployed (shyden.co.uk#1292); AC2's end-to-end proof waits on it.
