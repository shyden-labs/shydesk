# ShyDesk

A free, self-hostable support desk, released under the Apache-2.0 licence.
Customers ask for help through a hosted web form, with photo and short video
attachments, and follow their request through a private link. Staff work each
product's tickets in one desk, with canned replies and a read-only media viewer.
Reports, punishments and appeals sent from inside products follow in Release 2.

It runs on Cloudflare's free tier (Workers, D1, R2, Durable Objects, Turnstile,
Access) and sends no-reply notification emails through Oracle Cloud's free email
service. Anything specific to one deployment, such as domains and products, is
configuration, so anyone can run their own copy for free.

The approved design is
[`docs/superpowers/specs/2026-11-03-shydesk-v1-design.md`](docs/superpowers/specs/2026-11-03-shydesk-v1-design.md).
The app itself is being built; this repository currently holds its design, CI
and project tooling.

## What is here

| File | What it does |
| --- | --- |
| `.github/workflows/ci.yml` | On every pull request and every push to `develop`: install, `npm audit` (any known vulnerability fails), typecheck, lint, format check and unit tests (`build-and-test`), then coverage as one overall threshold over the TypeScript under `scripts/` (`coverage`). Its first step fails unless the default branch is `develop`. |
| `.github/dependabot.yml` | Version updates for npm, GitHub Actions and the Node pin, each targeting `develop`. |
| `.github/node/Dockerfile` | CI's one exact Node version (`FROM node:<major>.<minor>.<patch>`), bumped by Dependabot as a pull request of its own (shyden-labs/repo-template#143). |
| `scripts/npm-ci.ts` | Every workflow installs through it: `npm ci` that fails on any warning npm prints, naming each line (shyden-labs/repo-template#140). |
| `.github/workflows/sonarcloud.yml`, `scripts/sonar-verdict.ts`, `docs/sonarcloud.md` | A reusable SonarCloud scan whose quality gate blocks the pull request. |
| `.github/workflows/check-release-cut.yml`, `scripts/release-cut.ts`, `docs/release-cut.md` | Proves each pull request into `main` lands exactly a release cut CI tested. |
| `.github/workflows/deploy-dev.yml`, `scripts/deploy-dev.ts` | Every merge into `develop` deploys to dev and every pull request rehearses it. Until the app exists it deploys nothing, and fails naming any changed file that would need a deploy (shyden-labs/shydesk#7). |
| `scripts/branch-rules-setup.ts` | Sets the `develop` (squash only) and `main` (merge commit only) rulesets, head-branch deletion, rebase merging off and the `dev` environment's branch policy, and reads each back. |
| `scripts/board-*.ts`, `scripts/file-story.ts`, `.github/ISSUE_TEMPLATE/story.yml`, `docs/project-board.md` | The project board: filing stories, Estimate and Priority fields, the next ticket, progress, and orphaned In Progress tickets. |
| `tests/unit/supply-chain.test.ts` | Actions pinned to SHAs, Dependabot covering every ecosystem and targeting `develop`, Node read from the Dockerfile. |
| `tests/unit/licences.test.ts`, `tests/unit/licences.ts` | Every package in `package-lock.json` has a licence the global rule accepts: permissive if shipped, LGPL or MPL also allowed for build and test tools, GPL, AGPL, SSPL and unknown refused (shyden-labs/repo-template#169). |
| `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.githooks/pre-push`, `docs/static-checks.md` | Strict typecheck, lint and format, in CI and before every push. |
| `package.json` `overrides` | `minimatch` held at 11.0.3, past its ReDoS advisory GHSA-g3hv-75wg-m249, until eslint and typescript-eslint accept minimatch 11 themselves; then remove it (shyden-labs/repo-template#154). |
| `LICENSE`, `NOTICE` | Apache-2.0, the ASF's text verbatim in `LICENSE`; the copyright line in `NOTICE`, as the ASF advises (shyden-labs/repo-template#147). |

## The rules

1. **Pin actions to full commit SHAs**, with a trailing `# vX.Y.Z` comment so a Dependabot bump is reviewable.
2. **Dependabot covers every ecosystem and `github-actions`, targeting `develop`.**
3. **`develop` is the default branch**, because GitHub opens Dependabot security fixes against the default branch only.
4. **Warnings are build failures**: a vite or node warning fails the unit run.
5. **A unit test runs in under 1 s and starts no process and opens no connection** (`tests/setup/unit-refusal.ts`).
6. **Comments and docs cite issues in full**, as `owner/repo#N`, never a bare `#N` (`tests/unit/issue-refs.test.ts`; shyden-labs/repo-template#146). A repository made from this template copies every file, so a template reference such as `shyden-labs/repo-template#115` keeps pointing at the template's issue, and the new repository cites its own issues the same way. Test titles and messages are strings and are left as they are.

## Development

1. `npm ci && npm run test:unit`.
2. Before each push: `npm run test:unit`. The pre-push hook runs format, lint and typecheck.
3. Stories live on the ShyDesk Stories board; `docs/project-board.md` describes filing and progress.
