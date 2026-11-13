/**
 * Gives a repository one ruleset per long-lived branch, `develop` and `main`,
 * each naming its branch, requiring pull requests, the named checks, signed
 * commits, and no deletion or force push (issue shyden-labs/repo-template#8). `develop` requires the
 * checks run on an up-to-date branch ("strict"); `main` does not, because each
 * release merge lands on `main` and never on squash-only `develop`, so a strict
 * `main` would refuse every cut after the first. `main` requires `release-cut`
 * in its place (issue shyden-labs/repo-template#86, docs/release-cut.md). Run once per repository, by
 * the operator (rulesets need admin rights), after `develop` becomes the
 * default branch:
 *
 *   node scripts/branch-rules-setup.ts <owner/repo> <required check>...
 *
 * It refuses a ruleset that targets ~DEFAULT_BRANCH: that target moves when the
 * default branch changes, which is how ShyTalk's `main` lost its rules on
 * 2026-10-13. It creates what is missing, updates what differs, and reads both
 * branches' rules back, failing unless develop is strict and main is not and
 * requires release-cut and lets main be created before its checks have run
 * (issue shyden-labs/repo-template#171), and unless develop takes pull requests by squash alone
 * and main by merge commit alone (issue shyden-labs/repo-template#115). It sets the repository to
 * delete merged head branches and refuse rebase merges, reads that back, then lets every branch deploy to
 * the `dev` environment, which holds the dev credential, and reads that back too (Shyden 2026-11-13: anything
 * can deploy to dev at any time; shyden-labs/shydesk#136).
 */
import { execFileSync } from 'node:child_process';
import { runIfEntry } from './cli.ts';

export interface Rule {
  type: string;
  parameters?: unknown;
}

export interface RulesetBody {
  name: string;
  /** Who may bypass the ruleset; GitHub shows it only to an admin and answers `null` to anyone else. */
  bypass_actors?: unknown[] | null | undefined;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Rule[];
}

export interface ExistingRuleset extends RulesetBody {
  id: number;
}

export type Branch = 'develop' | 'main';
const BRANCHES: Branch[] = ['develop', 'main'];

/**
 * How each branch takes pull requests (shyden-labs/repo-template#115): `develop` by squash alone, so a
 * red commit fixed later on a ticket's branch never lands alone; `main` by
 * merge commit alone, so a release cut keeps develop's history whole.
 */
export const MERGE_METHOD: Record<Branch, string> = { develop: 'squash', main: 'merge' };

/** The commit status `.github/workflows/check-release-cut.yml` posts on each pull request into main's head. */
export const RELEASE_CUT = 'release-cut';

/** The ruleset a branch must carry. */
export function desiredRuleset(branch: Branch, checks: string[]): RulesetBody {
  if (checks.length === 0) {
    throw new Error('name at least one required check: a strict rule with no checks tests nothing');
  }
  if (checks.includes(RELEASE_CUT)) {
    throw new Error(`${RELEASE_CUT} runs only on pull requests into main: leave it out, and main gets it alone`);
  }
  const contexts = branch === 'main' ? [...checks, RELEASE_CUT] : checks;
  return {
    name: branch,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: [MERGE_METHOD[branch]],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: branch === 'develop',
          required_status_checks: contexts.map((context) => ({ context })),
          // A new main's first commit is never a pull request, so it has no checks, and
          // GitHub answers 422 when main is created unless they wait until after
          // (shyden-labs/repo-template#171). develop stays enforced from its creation.
          do_not_enforce_on_create: branch === 'main',
        },
      },
      { type: 'required_signatures' },
    ],
  };
}

/** Objects with their keys sorted, so two rulesets compare by content alone. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function shape(body: RulesetBody): string {
  const { name, target, enforcement, conditions, rules } = body;
  return canonical({ name, target, enforcement, conditions, rules });
}

/** One branch's ruleset: created, or updated or kept by its id. */
export type RulesetStep = { action: 'create'; body: RulesetBody } | { action: 'update' | 'keep'; id: number; body: RulesetBody };

/** What each branch's ruleset needs: created, updated by id, or kept. */
export function planRulesets(existing: ExistingRuleset[], checks: string[]): RulesetStep[] {
  for (const r of existing) {
    if (r.conditions.ref_name.include.includes('~DEFAULT_BRANCH')) {
      throw new Error(
        `ruleset ${r.id} "${r.name}" targets ~DEFAULT_BRANCH, which moves when the default branch changes: retarget it to refs/heads/<branch> or delete it first`,
      );
    }
  }
  return BRANCHES.map((branch) => {
    const body = desiredRuleset(branch, checks);
    const found = existing.find((r) => r.name === branch);
    if (found === undefined) return { action: 'create' as const, body };
    if (shape(found) === shape(body)) return { action: 'keep' as const, id: found.id, body };
    // Unmeasured whether a PUT leaving bypass_actors out keeps them, so the update carries them, and is never sent unseen.
    if (!Array.isArray(found.bypass_actors)) {
      throw new Error(
        `ruleset ${found.id} "${found.name}" differs, but its bypass list is hidden (read it with admin rights), so an update could drop a bypass`,
      );
    }
    return { action: 'update' as const, id: found.id, body: { ...body, bypass_actors: found.bypass_actors } };
  });
}

interface ChecksParameters {
  strict_required_status_checks_policy?: boolean;
  required_status_checks?: { context: string }[];
  do_not_enforce_on_create?: boolean;
}

/** Every way a branch's rules (as `rules/branches/<branch>` reports them) fall short; empty when none. */
export function auditBranchRules(branch: Branch, rules: Rule[]): string[] {
  const problems: string[] = [];
  // The repository deletes merged head branches (shyden-labs/repo-template#28), so a deletable
  // develop would go the first time a develop -> main pull request merges.
  if (!rules.some((r) => r.type === 'deletion')) {
    problems.push(`${branch}: no rule forbids deleting it`);
  }
  const pullRequests = rules.filter((r) => r.type === 'pull_request');
  if (pullRequests.length === 0) {
    problems.push(`${branch}: no rule requires a pull request`);
  }
  for (const r of pullRequests) {
    const methods = (r.parameters as { allowed_merge_methods?: string[] } | undefined)?.allowed_merge_methods;
    if (methods?.length !== 1 || methods[0] !== MERGE_METHOD[branch]) {
      const named = methods === undefined ? 'an unstated method' : methods.join(', ');
      problems.push(`${branch}: pull requests may merge by ${named}, not ${MERGE_METHOD[branch]} alone`);
    }
  }
  const checks = rules.filter((r) => r.type === 'required_status_checks').map((r) => (r.parameters ?? {}) as ChecksParameters);
  const requiresReleaseCut = checks.some((c) => c.required_status_checks?.some((s) => s.context === RELEASE_CUT) === true);
  if (checks.length === 0) {
    problems.push(`${branch}: no rule requires status checks`);
  } else if (branch === 'develop') {
    if (checks.some((c) => c.strict_required_status_checks_policy !== true)) {
      problems.push(`${branch}: a required-checks rule is not strict`);
    }
    if (requiresReleaseCut) {
      problems.push(`${branch}: a rule requires ${RELEASE_CUT}, which runs only on pull requests into main`);
    }
    if (checks.some((c) => c.do_not_enforce_on_create === true)) {
      problems.push(`${branch}: a required-checks rule is not enforced when develop is created`);
    }
  } else {
    if (checks.some((c) => c.strict_required_status_checks_policy !== false)) {
      problems.push(`${branch}: a required-checks rule is strict, so a second release cut could never merge`);
    }
    if (!requiresReleaseCut) {
      problems.push(`${branch}: no rule requires ${RELEASE_CUT}`);
    }
    if (checks.some((c) => c.do_not_enforce_on_create !== true)) {
      problems.push(`${branch}: a required-checks rule is enforced when main is created, so a new main can never be made`);
    }
  }
  return problems;
}

/** The repository settings a template copy does not carry, so the script sets them (shyden-labs/repo-template#28, shyden-labs/repo-template#115). */
const REPO_SETTINGS = {
  delete_branch_on_merge: { value: true, problem: 'merged head branches are not deleted' },
  allow_rebase_merge: { value: false, problem: 'rebase merging is allowed' },
  allow_squash_merge: { value: true, problem: 'squash merging is off, so develop could take no pull request' },
  allow_merge_commit: { value: true, problem: 'merge commits are off, so main could take no release cut' },
} as const;

export type RepoSettings = Partial<Record<keyof typeof REPO_SETTINGS, boolean>>;

/** Every way the repository's own settings (as `repos/<owner>/<repo>` reports them) fall short; empty when none. */
export function auditRepoSettings(repo: RepoSettings): string[] {
  return Object.entries(REPO_SETTINGS)
    .filter(([key, want]) => repo[key as keyof RepoSettings] !== want.value)
    .map(([key, want]) => `${want.problem} (${key} is ${String(repo[key as keyof RepoSettings])})`);
}

/** The environment that holds the dev credential, which every branch may deploy to (shyden-labs/shydesk#136). */
export const DEV_ENVIRONMENT = 'dev';

interface DevEnvironment {
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
}

/**
 * How `dev` (as `environments/dev` reports it) falls short of letting every branch deploy; empty when it
 * does (shyden-labs/shydesk#136). Fork pull requests get no secrets, and no job naming a dev environment
 * runs on pull_request_target (tests/unit/deploy-dev-anywhere.test.ts), so only those who can push reach it.
 */
export function auditDevEnvironment(env: DevEnvironment | undefined): string[] {
  if (env === undefined) return [`${DEV_ENVIRONMENT}: missing; deploy-dev.yml deploys there`];
  const policy = env.deployment_branch_policy;
  if (policy === null || policy === undefined) return [];
  return [
    `${DEV_ENVIRONMENT}: limits which branches may deploy (protected_branches ${String(policy.protected_branches)}, custom_branch_policies ${String(policy.custom_branch_policies)}), not every branch`,
  ];
}

/** gh's JSON answer. */
function gh(args: string[], input?: string): unknown {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', input }));
}

type ListedEnvironment = DevEnvironment & { name: string; protection_rules?: { type: string }[] };

/** Lets every branch deploy to `dev`, then reads it back (shyden-labs/shydesk#136). Prints `dev: set` or `dev: keep`. */
function setDevEnvironment(repo: string): void {
  const env = `repos/${repo}/environments/${DEV_ENVIRONMENT}`;
  const listed = (gh(['api', `repos/${repo}/environments`]) as { environments: ListedEnvironment[] }).environments;
  const before = listed.find((e) => e.name === DEV_ENVIRONMENT);
  const wrote = before === undefined || (before.deployment_branch_policy ?? null) !== null;
  if (wrote) {
    // Unmeasured whether a PUT naming only the branch policy keeps reviewers
    // and wait timers, so it is never sent over them.
    const kept = (before?.protection_rules ?? []).map((r) => r.type).filter((type) => type !== 'branch_policy');
    if (kept.length > 0) {
      throw new Error(
        `${DEV_ENVIRONMENT} has protection rules (${kept.join(', ')}) that setting its branch policy could drop: set its deployment branches to all branches by hand, then run this again`,
      );
    }
    gh(['api', '-X', 'PUT', env, '--input', '-'], JSON.stringify({ deployment_branch_policy: null }));
  }
  const problems = auditDevEnvironment(gh(['api', env]) as DevEnvironment);
  if (problems.length > 0) {
    throw new Error(`read back, the dev environment still falls short:\n  ${problems.join('\n  ')}`);
  }
  process.stdout.write(`${DEV_ENVIRONMENT}: ${wrote ? 'set' : 'keep'}\n`);
}

export function main(args: string[]): number {
  const [repo, ...checks] = args;
  if (repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo) || checks.length === 0) {
    throw new Error('usage: node scripts/branch-rules-setup.ts <owner/repo> <required check>...');
  }
  const summaries = gh(['api', `repos/${repo}/rulesets`]) as { id: number }[];
  const existing = summaries.map((s) => gh(['api', `repos/${repo}/rulesets/${s.id}`]) as ExistingRuleset);
  for (const step of planRulesets(existing, checks)) {
    if (step.action === 'create') {
      gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(step.body));
    } else if (step.action === 'update') {
      gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${step.id}`, '--input', '-'], JSON.stringify(step.body));
    }
    process.stdout.write(`${step.body.name}: ${step.action}\n`);
  }
  const problems = BRANCHES.flatMap((b) => auditBranchRules(b, gh(['api', `repos/${repo}/rules/branches/${b}`]) as Rule[]));
  if (problems.length > 0) {
    throw new Error(`read back, the rules still fall short:\n  ${problems.join('\n  ')}`);
  }
  // Only now that neither branch can be deleted: a merged pull request's head
  // branch is deleted with it (shyden-labs/repo-template#28). A template copies files, not settings.
  gh([
    'api',
    '-X',
    'PATCH',
    `repos/${repo}`,
    ...Object.entries(REPO_SETTINGS).flatMap(([key, want]) => ['-F', `${key}=${String(want.value)}`]),
  ]);
  const settings = auditRepoSettings(gh(['api', `repos/${repo}`]) as RepoSettings);
  if (settings.length > 0) {
    throw new Error(`read back, the repository still falls short:\n  ${settings.join('\n  ')}`);
  }
  setDevEnvironment(repo);
  process.stdout.write(
    `${repo}: develop requires strict checks; main requires ${RELEASE_CUT} instead; both forbid deletion and require pull requests; develop takes squashes alone and main merge commits alone, with rebase merging off; merged head branches are deleted; ${DEV_ENVIRONMENT} deploys from any branch.\n`,
  );
  return 0;
}

await runIfEntry(import.meta.url, main);
