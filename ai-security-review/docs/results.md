# Understand a Review Result

For PR authors and reviewers; start with the AI security review comment or its linked Actions run and check that the
reviewed commit matches your PR head.

> **Public repositories:** Review comments and candidate artifacts can expose attack details, including issues later
> rejected by verification. **If a finding affects deployed code, fix it privately, not in a public PR.** See
> [public visibility and data handling](security-model.md#data-handling).

## Read the Comment

A completed review identifies the reviewed commit, coverage, verified findings, human-review notices, and whether
candidate verification ran. It also states the active finding policy. No findings means that no reportable finding
survived this run's review and filtering; see the [security limitations](security-model.md#limitations).

The engine maintains one sticky comment per PR. A newer completed review replaces its content, including when it finds
nothing. Findings omitted from an oversized comment remain in the result artifact; higher-severity findings appear
first.

| Result                                     | What to do                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete, no findings or notices           | Continue the repository's normal review process.                                                                                                |
| Verified HIGH or MEDIUM finding            | Inspect the cited path, evidence, and impact; fix or explicitly resolve the finding. Findings fail the final check when enforcement is enabled. |
| Human-review notice                        | Investigate the dependency, submodule pointer, or suspected prompt injection. Notices alone do not fail the gate.                               |
| Incomplete review or source-policy failure | Inspect the failed job; this is not a clean result. Resolve the failure before retrying.                                                        |

For a required merge check, see [finding policy and recovery paths](required-review.md). Merge-group reviews upload
artifacts without updating a PR comment.

## Investigate Human-Review Notices

- **Unclassified dependencies:** a changed lockfile entry could not be fully modeled. Ordinary pnpm bumps can produce
  this notice because they use integrity values and implicit registries. Check the original patch and recorded
  dependency changes.
- **Submodule changes:** inspect the before/after commit pointers and review the referenced code separately. The engine
  does not fetch or analyze submodule contents.
- **Prompt-injection signals:** inspect the cited instructions in source, metadata, or tool-read context. Documentation
  and fixtures can trigger the heuristic too. These warnings survive a clean model result and do not fail the gate, even
  with `fail_on_findings: true`.

Changed explicit `npm:` alias targets appear as `reviewNotice: "alias-target-change"` in `dependency_changes` and count
as unclassified records. Check the parent package's trusted manifest and the intended dependency name; a matching
registry tarball path does not prove the alias was intended. This notice survives a CLEAN review but does not itself
fail the findings gate.

## Inspect Artifacts and Diagnostics

Open the Actions run linked in the comment. Artifact names include the run ID:

| Artifact prefix                   | Contents                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ai-security-review-plan-`        | Changed-file manifest, unit patches, prompts, context, and bounded base snapshots.                |
| `ai-security-review-candidates-`  | Reported candidate findings with attack details, including issues later rejected by verification. |
| `ai-security-review-result-`      | `result.json` with full results and `comment.md`.                                                 |
| `ai-security-review-diagnostics-` | Sanitized reviewer/verifier failure details and numeric session metrics.                          |

Failed preparation or verification may leave no result artifact. The
[central retention setting](configuration.md#central-settings) applies to CLI, plan, candidate, result, and diagnostic
artifacts. Artifacts can contain repository source; see [data handling](security-model.md#data-handling).

Diagnostics identify the failure stage and, when available, a unit ID, invalid citation, missing-read range, turns, and
cost. Session failures may also include an error category, HTTP status, schema field, and recognized reason. These are
best-effort: neither the CLI's error format nor the API's message text is a documented contract.

A 400 without a field or reason can also indicate an organization or workspace spend limit. Check provider billing and
the [API error guidance](https://platform.claude.com/docs/en/api/errors#http-errors). Missing execution output can leave
only a generic incomplete-session message; raw transcripts and provider request IDs are not retained.

## Recover From a Failed Review

1. Open the failed job and its sanitized diagnostics. Determine whether failure occurred during preparation, model
   execution, validation, or publication.
2. Fix the cause: approved dependency source, malformed input, missing context, exhausted budget, authentication, or an
   engine defect. Model-budget and authentication changes may require the repository owner.
3. Re-run failed jobs while prerequisite artifacts remain available. If they expired or are missing, re-run all jobs or
   push a new commit.

**Re-run all jobs** and new pushes that trigger review start fresh model reviews. Findings can disappear even when the
issue remains: the latest run controls the gate and replaces the sticky comment. Resolve previous findings explicitly;
the engine maintains no ledger of unresolved findings.

Rerunning only a failed `Complete` job reuses the existing finding count. That job's finding-policy failure leaves the
completed findings comment intact.

## If a Comment Is Missing

Check whether this is a merge-group run, an unsupported fork, a skipped caller, or a failure before publication. The
publisher also skips stale heads after a newer commit reaches the PR. Check the run's `Publish result` and `Complete`
jobs instead of treating silence as a clean review.

Publisher jobs serialize updates per repository and PR, and check the current head before writing. A cancelled
publication cannot produce successful completion. The engine updates only its own bot comments; older reviewers'
comments are not managed or removed.

<details>
<summary>Publication identity and queue behavior</summary>

Only publisher jobs share the engine's per-repository, per-PR concurrency group. Active publishers are not cancelled; up
to 100 can wait before additional queued jobs are rejected. Each checks the PR head after entering its running slot. See
[GitHub's concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

The publisher selects only `github-actions[bot]` comments beginning with `<!-- matter-labs-ai-security-review -->`.
Updates and duplicate cleanup leave human comments, other markers, and older reviewers' status comments alone. Removing
those comments requires a separate explicit cleanup.

</details>
