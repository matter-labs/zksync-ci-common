# Integration Examples

For repository owners choosing a caller or configuration; first follow [setup](../README.md#set-up) and verify the
engine SHA.

## Caller Templates

| Template                                        | Trigger policy                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [pull-requests](callers/pull-requests.yaml)     | Every non-draft, same-repository PR on opening, reopening, pushes, and readiness.                |
| [labelled-drafts](callers/labelled-drafts.yaml) | Same-repository PRs carrying `ai-security-review`, including drafts.                             |
| [merge-queue](callers/merge-queue.yaml)         | Non-draft, same-repository PRs plus merge-group changes.                                         |
| [required-review](callers/required-review.yaml) | Same coverage as merge-queue, with finding enforcement and a check that rejects skipped reviews. |

Pass the selected template name as the generator's final argument during
[caller creation](../README.md#create-a-repository-caller). Install one caller only. Templates contain
`ENGINE_COMMIT_SHA`; the generator replaces it with your literal reviewed SHA and refuses to overwrite an existing
caller.

All templates use federation and skip fork and Dependabot-triggered PR runs. Other bots are eligible unless you add an
exclusion. Active reviews finish while the newest pending run is retained. Labels and draft eligibility belong to the
caller, not the engine.

The labelled-drafts template runs when `ai-security-review` is added, and on opening, reopening, or pushes while it is
present. Unrelated labels and marking a draft ready do not repeat a review; removing the label does not cancel an active
run.

See [authentication](../docs/authentication.md) for API-key wiring and [required review](../docs/required-review.md) for
finding enforcement, rulesets, and bot/fork recovery paths.

## Repository Configurations

Copy a configuration to `.github/ai-security-review.json` and adapt its paths and profiles:

| Configuration                                                               | Intended project                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [web-service.json](repository-configs/web-service.json)                     | API and web application with authorization and response boundaries. |
| [rust-service.json](repository-configs/rust-service.json)                   | RPC service and distributed state processing.                       |
| [smart-contracts.json](repository-configs/smart-contracts.json)             | Solidity contracts, cross-chain messages, and authorization.        |
| [compiler-and-circuits.json](repository-configs/compiler-and-circuits.json) | Compiler, VM, and proof-system components.                          |
| [infrastructure.json](repository-configs/infrastructure.json)               | Terraform, Kubernetes, and privileged automation.                   |

These are generic layouts. Profile IDs are checked by CI. The examples grant no extra source approvals; use the
[configuration reference](../docs/configuration.md) to configure those separately.

## Focus Files

| Sample                            | Suggested consumer path                 |
| --------------------------------- | --------------------------------------- |
| [Application focus](focus/app.md) | `.github/security-review-focus-main.md` |
| [CI focus](focus/ci.md)           | `.github/security-review-focus-ci.md`   |

For the single-file setup, copy and adapt the application sample as `.github/security-review-focus.md`. For two files,
use the [multiple-focus configuration](../docs/configuration.md#use-multiple-focus-files). Context files must exist on
the base branch before the engine uses them.
