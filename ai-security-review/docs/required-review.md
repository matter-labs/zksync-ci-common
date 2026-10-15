# Make the Review Required

For repository administrators configuring merge protection; first complete [caller setup](../README.md#set-up) and
decide how bot and fork PRs will obtain a supported review.

## Install the Required-Review Caller

During [caller generation](../README.md#create-a-repository-caller), choose `required-review` as the final argument.
Install it instead of another caller, not alongside one. It reviews non-draft same-repository PRs and merge groups.

The template sets `fail_on_findings: true` and adds a stable `AI security review required` job. That job accepts only a
successful reusable-workflow result, including when the review is skipped or cancelled. Its five-minute timeout applies
only to the short result check after the engine jobs finish, not to the time spent waiting for review.

After the caller has run, add **AI security review required** under required status checks in **Settings > Rules >
Rulesets** or branch protection. Select the emitted check name and GitHub Actions as its expected source. YAML alone
does not make a failure block merging; see
[GitHub's required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).

A required review must cover every merge-eligible PR. The labelled template is unsuitable as an unconditional merge gate
because unlabelled PRs skip review. Requiring the review job directly can also permit skips, since
[GitHub treats skipped jobs as successful](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions).

## Choose the Finding Policy

Set `fail_on_findings` in the reusable job's `with` block:

| Policy  | Complete review with verified findings        | Incomplete review or source-policy violation | Human-review notice only |
| ------- | --------------------------------------------- | -------------------------------------------- | ------------------------ |
| `false` | Succeeds; findings remain advisory.           | Fails.                                       | Succeeds.                |
| `true`  | Fails on any verified HIGH or MEDIUM finding. | Fails.                                       | Succeeds.                |

The required-review template selects `true`; other templates use the [input default](configuration.md#caller-inputs).
Enforcement uses the final verified count, including findings omitted from a size-limited comment. Rejected candidates
and LOW findings do not count; missing or invalid counts fail when enforcement is enabled.

Finding enforcement runs after result upload and PR comment publication. A finding failure leaves the completed review
visible instead of replacing it with an incomplete-review message. Merge-group reviews enforce the same policy after
artifact upload without a PR comment.

Prompt-injection warnings do not fail either mode; a human must investigate them. New pushes and **Re-run all jobs** can
produce different findings without fixing earlier issues. Require explicit resolution of earlier findings; see
[rerun behavior](results.md#recover-from-a-failed-review).

## Protect Caller Changes

A PR can edit its repository-owned caller or imitate a successful named check. Require trusted code-owner approval for
all `.github/workflows/` files and CODEOWNERS itself. For example, replace `@your-org/security-owners` with a real,
visible team that has explicit Write access:

```text
/.github/workflows/ @your-org/security-owners
/.github/CODEOWNERS @your-org/security-owners
```

Enable required code-owner review, dismiss stale approvals, require approval of the latest push, and restrict bypasses.
Install these controls on the base branch before relying on them. Team members' individual permissions do not satisfy
the team's access requirement, and listing owners does not grant permissions. See
[GitHub's CODEOWNERS requirements](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

These controls protect merging, not execution. A PR's changed workflow can run before owner approval; runtime credential
access depends on Actions settings, secret availability, permissions, and federation conditions. See
[authentication](authentication.md) before exposing credentials.

This `workflow_call`-only engine cannot be selected directly as an organization-required workflow. That enforcement mode
needs a separately reviewed implementation with supported event triggers, authentication, and coverage tests. See
[GitHub's required-workflow rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging).

## Review Bot and Fork Pull Requests

Choose supported review paths before making the check required:

- **Dependabot:** a maintainer can review the proposed changes and push a new commit to the same-repository Dependabot
  branch using their own credentials. An empty commit is sufficient to trigger a new `synchronize` run. The caller
  checks `github.actor`, not the PR author, so that new maintainer-triggered run can review the PR. Rerunning the
  original Dependabot run retains its restricted privileges. Adding commits normally stops Dependabot's automatic
  rebasing, so the maintainer takes responsibility for keeping that branch current. See
  [Dependabot's Actions restrictions](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions)
  and
  [PR management](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs).
- **Automation using `GITHUB_TOKEN`:** GitHub creates approval-required runs for `pull_request` events of type `opened`,
  `synchronize`, and `reopened`. A user with write access must choose **Approve workflows to run** in the PR merge box.
  Other events, including `labeled`, do not trigger workflows when generated with that token. For automatic triggering,
  use a GitHub App installation token with the required repository permissions, or a suitably scoped personal access
  token. See [GitHub's token-trigger rules](https://docs.github.com/en/actions/concepts/security/github_token).
- **Forks:** after inspecting the changes, a maintainer can bring them onto a same-repository branch and open a new PR
  for review. Inspect workflow changes before pushing: the new PR can receive repository credentials. The engine does
  not review the original fork PR.

These paths obtain an actual review; they do not exempt unsupported PRs from the required check.

Drafts fail the required check until marked ready and reviewed. Merge queues need the supplied `merge_group` trigger and
matching federation event authorization. Check a real run for each supported path before enabling the required check.
