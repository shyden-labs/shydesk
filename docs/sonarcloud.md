# SonarCloud

Every repository runs SonarCloud on every pull request, and a failed quality
gate blocks it (issue shyden-labs/repo-template#27). Shyden ruled on 2026-10-18 that a scan
that does not run must fail, and that the results must be checked, failing the
workflow when the gate fails. Then, asked how: every project adopts SonarCloud,
blocking.

## What the template gives you

- `.github/workflows/sonarcloud.yml`, a reusable workflow. It fails when
  `SONAR_TOKEN` is missing, and runs the coverage command (a failure there
  fails the job). It then scans and reads the quality gate of that scan's
  analysis, with `scripts/sonar-verdict.ts`. It is green only on `OK`; `ERROR`
  fails, naming each failed condition with its value and threshold.
- The scan treats `tests/` as tests, not source, and leaves the config files
  the unit suite does not measure out of coverage (issue shyden-labs/repo-template#164). A project with
  other unmeasured files adds them to `sonar.coverage.exclusions`.
- A verdict it cannot read fails closed, naming why:
  - a missing report (the scan did not run)
  - an API error
  - a task that failed
  - no analysis
  - a task for another pull request
  - still pending after the ceiling (`SONAR_CEILING_SECONDS`, 300 by default)
- The job summary says whether the scan ran, the verdict, and the SonarCloud
  link.
- `tests/unit/workflow-honesty.test.ts` refuses, in every workflow, a swallowed
  failure (`|| true`, `|| exit 0`, `|| :`, `continue-on-error: true`), a step
  gated on the token, and a scan with no verdict step after it.

## One-time setup for a new repository

1. On [sonarcloud.io](https://sonarcloud.io), sign in with GitHub, open the
   `shyden-labs` organisation, choose **Analyze new project**, and pick the
   repository. Note the project key (usually `shyden-labs_<repo>`). If the
   repository isn't listed, follow **GitHub app configuration** on that page
   and add it to the SonarQubeCloud app's repository access.
2. In the project, open **Administration → Analysis Method** and turn
   **Automatic Analysis** off: CI runs the scan.
3. In **Administration → New Code**, set the new-code definition to
   **Previous version**, or to the branch your project diffs against.
4. Under **My Account → Security**, generate a token.
5. In the GitHub repository, open **Settings → Secrets and variables →
   Actions** and add it as `SONAR_TOKEN`. Then do the same under **Dependabot**
   secrets: Dependabot pull requests don't receive Actions secrets, and they
   are scanned too.
6. Call the workflow from the pull-request workflow, and make its job a
   required check on `develop` and `main`:

   ```yaml
   sonarcloud:
     uses: ./.github/workflows/sonarcloud.yml
     with:
       organization: shyden-labs
       project-key: shyden-labs_<repo>
     secrets: inherit
   ```

## Confirmed by the first real scan

repo-template's PR shyden-labs/repo-template#160 (2026-10-31) confirmed what no document read on
2026-10-22 stated:

- The scan action writes `.scannerwork/report-task.txt` holding `ceTaskId`,
  `serverUrl` and `dashboardUrl`.
- A pull request's analysis task names its `pullRequest`.

Uncovered code planted on that PR failed the gate, as it should:
`new_coverage is 0.0, which fails LT 80`.

SonarCloud's documentation marks `api/qualitygates/project_status`
deprecated (since 2025-09-16). It still answered on 2026-10-31. Move to its
replacement when SonarCloud retires it.
