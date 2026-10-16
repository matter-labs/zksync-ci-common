# Maintaining AI Security Review

For engine maintainers; use a local engine checkout and the validation tools listed below.

The workflow and everything under `ai-security-review/` form one versioned engine. Consumers pin a full commit SHA.
Review changes to prompts, tests, schemas, dependency parsers, diagnostics, and publication with the same care as the
workflow: they can change which findings are reported and which content reaches a provider or PR comment.

## Repository Settings

Files in a pull request cannot enable these GitHub settings. Configure them separately before distributing an engine
pin:

- Protect `main` with required pull requests, code-owner approval, stale-approval dismissal, and approval of the most
  recent push by another reviewer. Keep bypass permissions narrowly assigned and block force pushes and branch deletion.
- Require the `AI review engine checks` job. Engine CI runs on every PR and merge-group event without path filters.
  Require the repository's existing secrets scan as well.
- Confirm each CODEOWNERS team is visible and has explicit write access. Protect CODEOWNERS itself. Multiple owners on
  one rule permit approval by any listed owner; they do not require an approval from every team.
- Use a read-only default GitHub token. Do not expose model credentials, organization secrets, or OIDC trust to engine
  CI. Its model compatibility tests use a local fake API and dummy credentials.
- Require approval for workflows from external contributors according to organization policy. Keep engine validation on
  GitHub-hosted runners. Do not run untrusted PR code using `pull_request_target` and elevated credentials.
- Keep GitHub Actions dependencies pinned to reviewed full commit SHAs. If enabling GitHub's SHA-pin policy, check the
  existing repository workflows for compatibility. Review Dependabot updates before merging; do not auto-merge them.

See
[GitHub's code-owner requirements](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
and
[ruleset settings](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).
CODEOWNERS is stored on the PR base branch; a new ownership file does not enforce its own initial installation.

## Run Validation

Use Node.js 22.22.2 or later in the 22.x line, Bun 1.3.14, Git with `--attr-source` support, `jq`, and `tar`. The pinned
CLI check requires Linux x64. From the repository root:

```bash
npm ci --prefix ai-security-review --workspaces=false --ignore-scripts --no-audit --no-fund
npm audit --audit-level moderate --prefix ai-security-review
npx --yes prettier@3.6.2 --config ai-security-review/.prettierrc.json --check \
  ai-security-review .github/workflows/ai-security-review*.yaml .github/dependabot.yml
BUN_EXECUTABLE=bun node --test ai-security-review/test/*.test.mjs
node ai-security-review/scripts/smoke-test-claude-cli.mjs
```

Unit and integration tests create disposable repositories. The CLI smoke test downloads only the integrity-pinned
platform archive and sends dummy requests to a loopback fake API. No paid model request or real credential is needed.

### What the Checks Cover

- Unit and integration tests cover planning, schemas, coverage, diagnostics, finding enforcement, and publication
  against a local GitHub API fixture. Install `jq` for the publisher tests.
- Hostile long-input cases exercise source URL scanning, redaction, routing, prompt-injection detection, TOML parsing,
  and session-error classification.
- Artifact tests verify restored CLI bytes and executable mode before extraction. The native CLI harness exercises both
  action configurations against a loopback fake API with dummy credentials, including denied tools, paths, symlinks, and
  preload/ dotenv isolation.
- Documentation tests check relative links and anchors, documented workflow settings and input defaults, and
  configuration examples. Static import-graph tests traverse every credentialed entrypoint; rendering tests cover
  backslash payloads and ICU-independent ordering. The caller tests execute the README's SHA-verification script against
  a local API fixture.

The npm audit fails on Moderate or higher advisories and on audit errors. `BUN_EXECUTABLE` enables launcher regression
coverage; CI supplies the pinned runtime. Local tests do not execute GitHub's scheduler or prove real provider schema
acceptance, permissions, federation rules, billing behavior, or retention configuration.

## Dependency Updates

Dependabot proposes weekly parser and GitHub Actions updates, including the reviewer and verifier composite actions.
Parser versions and their lockfile integrity values must remain pinned. `hosted-git-info` defines npm hosted Git URL
semantics; rerun source-policy and hostile-input regressions when upgrading it. CommonMark is a test-only dependency
that checks rendered comments for active links and images; production preparation omits dev dependencies. Install with
lifecycle scripts disabled. Keep reviewer and verifier modules independent of parser dependencies; the prepare job is
the only model-workflow job that installs them.

The package's `private: true` setting prevents accidental npm publication; distribution uses the reusable workflow.

The Claude CLI is a separately verified runtime dependency, not a package.json dependency. Change `CLAUDE_CLI_VERSION`,
`CLAUDE_CLI_URL`, and `CLAUDE_CLI_INTEGRITY` together in the reusable workflow. Check the integrity value against the
exact platform package's npm metadata. Every consuming job verifies the archive before extraction. Engine CI checks the
version, executable mode, available flags, and compatibility with both action configurations. Review the associated
Anthropic base-action pin and Bun runtime when upgrading.

Prettier is pinned in CI; use its explicit engine configuration so unrelated repository formatting cannot change the
engine checks. Review upstream changes and rerun the suite when updating any pin. The native CLI remains under its own
license and is not vendored in this repository.

## Release a Reviewed Revision

1. Update [CHANGELOG.md](CHANGELOG.md) with consumer-visible changes under Unreleased. Review the diff, engine CI,
   dependency audit, and secret scan. Confirm no repository-specific context, real credentials, model transcripts, or
   generated run artifacts are included.
2. Merge through the protected branch and record the resulting full SHA. Follow the
   [revision verification](README.md#verify-an-engine-revision) to check reachability from `main` and the required
   files. Apply it before distributing a pin for either authentication method. A branch name or moving tag is not a
   consumer pin.
3. Update the Anthropic federation trust and consumer pin together. Limit trust to approved consumers and the exact
   `job_workflow_ref`. When transitioning pins, retain the previous trusted revision only while it is needed. Follow the
   [required trust conditions](docs/authentication.md#required-trust-conditions) and verify that an unauthorized caller
   cannot exchange a token. Run the [federation boundary checks](docs/authentication.md#verify-the-federation-boundary)
   without an API-key fallback.
4. Exercise a same-repository PR in a designated integration repository using its real authentication. Cover a clean
   result, candidate verification, a deterministic human-review notice, and a failure. Use only synthetic test changes.
   Close deliberately vulnerable test PRs without merging them.
5. Check the sticky comment, reviewed SHA, artifacts, completion job, and measured cost. Re-run all jobs to check
   artifact replacement. Check both `fail_on_findings` modes: findings must remain published when enforcement fails the
   final check, and clean results must pass. If enabling merge queues, verify a merge-group run as well.
6. Update other consumers after reviewing that evidence. If rollback is needed, restore the previous full pin and its
   narrowly scoped trust rule. Disabling a caller does not cancel existing runs.

Live integration requests incur provider charges and run in the consumer context. Engine CI never enables this
implicitly. There is no published release SHA until a reviewed engine commit exists in this repository.

Record the public merge date and link the reviewed revision in release notes after merge. A commit cannot contain its
own final SHA; do not invent one in the changelog. Keep unreleased entries distinct from published history and omit
private development history.

When forking or renaming the engine, change the checkout repository and `EXPECTED_REPOSITORY` guards together before
consumers pin the new revision. Read the [security model](docs/security-model.md) before changing those boundaries.
