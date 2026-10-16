# Configure Review Coverage

For repository owners tuning a configured caller; keep the engine SHA reviewed and merge trusted configuration changes
into the PR base branch first.

## Caller Inputs

Set these under the reusable job's `with` block:

| Input              | Default | Effect                                                                                                                                        |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `maximum_batches`  | `24`    | Positive batch limit; exceeding it fails preparation. Raising it permits more sessions and spending.                                          |
| `fail_on_findings` | `false` | Fail the final check on verified HIGH or MEDIUM findings after publication. See [merge policy](required-review.md#choose-the-finding-policy). |

## Central Settings

These settings live in the reusable workflow's top-level `env`. Callers cannot override them through their own
environment variables. Change the engine, review the revision, then update consumer pins.

| Setting                                      | Current value                  | Meaning                                                     |
| -------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `NODE_VERSION`                               | `22`                           | Node.js major used by every engine job and the base action. |
| `AI_SECURITY_REVIEW_MODEL`                   | `claude-opus-4-8`              | Reviewer and verifier model.                                |
| `AI_SECURITY_REVIEW_EFFORT`                  | `high`                         | Model effort.                                               |
| `AI_SECURITY_REVIEW_REVIEW_MAX_BUDGET_USD`   | `20`                           | USD per reviewer batch.                                     |
| `AI_SECURITY_REVIEW_VERIFY_MAX_BUDGET_USD`   | `20`                           | USD per verifier session.                                   |
| `AI_SECURITY_REVIEW_MAXIMUM_UNIT_BYTES`      | `80000`                        | Maximum patch-unit bytes.                                   |
| `AI_SECURITY_REVIEW_MAXIMUM_BATCH_BYTES`     | `160000`                       | Maximum batch bytes.                                        |
| `CLAUDE_CLI_VERSION`                         | `2.1.296`                      | Integrity-pinned native CLI.                                |
| `AI_SECURITY_REVIEW_ARTIFACT_RETENTION_DAYS` | `7`                            | Days retained for every engine artifact.                    |
| `AI_SECURITY_REVIEW_ENGINE_REPOSITORY`       | `matter-labs/zksync-ci-common` | Expected reusable workflow repository.                      |
| `AI_SECURITY_REVIEW_OIDC_AUDIENCE`           | `https://api.anthropic.com`    | Audience used when obtaining OIDC tokens.                   |

`CLAUDE_CLI_URL` and `CLAUDE_CLI_INTEGRITY` are paired with the version in the
[workflow](../../.github/workflows/ai-security-review.yaml); change all three together.
`AI_SECURITY_REVIEW_MAXIMUM_BATCHES` forwards the caller input rather than defining another default. Runners, timeouts,
and matrix concurrency remain job settings.

Artifact retention is configured centrally; the table above gives the current period. Callers cannot override it. See
[artifacts and reruns](results.md#inspect-artifacts-and-diagnostics) for how retention affects recovery.

## Repository Configuration

Create `.github/ai-security-review.json` using the [schema](../schemas/repository-config.schema.json) and
[examples](../examples/README.md#repository-configurations).

| Field                    | Purpose                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `version`                | Required; `1`.                                                               |
| `profiles`               | Additional built-in profiles for every path.                                 |
| `pathProfiles`           | Additional built-in profiles selected by path globs.                         |
| `context`                | Trusted repository files included in every reviewer batch.                   |
| `groupRoots`             | Directories for grouping related changes into batches.                       |
| `allowedLockfileHosts`   | Additional approved registry hosts.                                          |
| `allowedLockfileSources` | Exact approved HTTPS repository origins, without a trailing slash or `.git`. |

Configuration and context come from the PR base commit, not its head. These settings cannot remove mandatory profiles or
completeness checks. An empty `context` list uses `.github/security-review-focus.md` when present; a non-empty list
selects only its named files.

### Use Multiple Focus Files

For separate application and CI guidance, use:

```json
{
  "version": 1,
  "context": [".github/security-review-focus-main.md", ".github/security-review-focus-ci.md"],
  "pathProfiles": [
    {
      "paths": [".github/**", "deployments/**", "Dockerfile*", "**/Dockerfile*"],
      "profiles": ["domains/privileged-automation"]
    }
  ]
}
```

Copy [app.md](../examples/focus/app.md) and [ci.md](../examples/focus/ci.md) to the two named context paths. Adapt their
invariants and keep the opening scope sentence. The CI sample applies to `.github/**`, `deployments/**`, and Dockerfiles
at any directory level.

Every reviewer batch receives both files in full, including batches containing only application changes. Scope sentences
guide the model; they do not enforce routing or path isolation. `pathProfiles` selects built-in profiles, not context
files.

You can list up to ten context files, limited to 128 KiB per file and 256 KiB combined. Keep them concise because they
are repeated in every reviewer batch. Missing configured files fail preparation; a non-empty list replaces the automatic
fallback, so include every file you need.

## Select Profiles

In `pathProfiles.paths`, `*` matches within one path segment, `?` matches one non-slash character, and `**` can cross
directory boundaries. `**/` also matches zero directories. Patterns are case-sensitive and relative to the repository
root; bracket expressions, brace expansion, and negation are not supported operators.

Profiles are additive prompt-policy fragments under `profiles/`. The workflow selects these profiles automatically:

- `universal.md` for every eligible file.
- Language profiles for Go, native code, Python, Rust, shell, Solidity, and TypeScript or JavaScript.
- `domains/ci-supply-chain` for CI workflows, deployment definitions, container builds, dependency manifests, and
  lockfiles.
- `domains/infrastructure-as-code` for Terraform, Pulumi, Helm, Kubernetes, Ansible, and related infrastructure paths.

Repositories select specialized profiles globally or by path with `.github/ai-security-review.json`. Available domains
cover AI agents, authorization, bridges, compilers and virtual machines, cryptography, distributed systems, HTTP and RPC
services, policy engines, privacy and data exposure, privileged automation, smart contracts, wallets, web clients, and
zero-knowledge circuits.

The repository configuration is always read from the pull request base commit. It can add trusted context and profiles,
but it cannot disable the universal profile, change credentials or model selection, suppress completeness validation, or
load arbitrary central files. See the [repository examples](../examples/README.md#repository-configurations) for
configuration patterns.

### Content-Aware Routing

Preparation augments the path, language, and base-configuration profiles with fixed content signals. It never removes an
existing profile or calls a model to classify files. Universal and language profiles still cover security categories
without a specialist match.

Content routing recognizes JavaScript/TypeScript module references and specific API patterns, plus co-occurring
IAM-style policy keys. These signals map only to existing central profiles:

| Content signal                                                                                         | Added profiles                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `crypto` or `node:crypto` module references; supported `crypto.subtle` calls                           | `domains/cryptography`                           |
| `jose` or `jsonwebtoken` module references                                                             | `domains/authorization`, `domains/cryptography`  |
| `casbin`, `@casl/ability`, or `@open-policy-agent/opa-wasm` module references; IAM-style policy keys   | `domains/authorization`, `domains/policy-engine` |
| `http`, `https`, their `node:` forms, `undici`, or `axios` module references; `globalThis.fetch` calls | `domains/http-service`                           |

Module matching recognizes import, export-from, dynamic-import, and `require` forms, including aliased imports. The
policy signal requires a `Statement` array marker, an `Allow` or `Deny` effect, and Action/NotAction and
Resource/NotResource keys. [The signal catalogue](../scripts/content-profile-signals.mjs) defines the exact literal
patterns. It does not parse syntax or resolve bindings: comments, strings, and unrelated policy keys can also activate a
lens. Generic SQL, deserialization, and subprocess calls do not add specialist profiles.

Preparation scans committed merge-base and head blobs, using the previous path for renames. This preserves signals from
removed controls and unchanged imports outside the diff. Full-file reads have a 512 KiB per-blob limit and a separate 16
MiB aggregate budget. Larger files, exhausted budgets, unavailable blobs, or binary versions fall back to the available
patch chunks. Routing records identify each revision as `full`, `absent`, or `patch-only` with its limitation reason.
Patch-only scans can miss unchanged imports and patterns spanning chunks; limited coverage does not fail routing.

The plan and changed-file manifest retain per-file routing records with fixed signal IDs and base/head line numbers, not
matched source snippets. Each batch prompt includes those records and each unit's selected profiles. Repeated matches
produce at most seven signal records per file and add at most four distinct domain profiles. Overlapping bounded scan
windows preserve matches at window edges. Batch records measure prompt, profile-text, and routing-metadata bytes; these
measurements do not enforce a model-context budget.

Routing adds review guidance; matches are not findings. See the [coverage limitations](security-model.md#limitations).

## Group Changes Into Batches

Related files are batched together by the nearest directory that contains a package manifest such as `Cargo.toml`,
`package.json`, `go.mod`, `pyproject.toml`, `foundry.toml`, `pom.xml`, or `build.gradle`, read from the base and head
trees. A root-level manifest does not form a group, so monorepos fall back to the top-level directory. Use `groupRoots`
to name directories that should form groups when a repository has no manifests or an unusual layout. Groups are packed
into batches up to both the byte limit and 200 units, matching the structured-output schema. Both group splitting and
batch merging enforce these limits. Exceeding `maximum_batches` fails preparation without dropping units.

Oversized patches are split within hunks while retaining every changed record and its coordinates. Excess unchanged
context can be trimmed. A changed line that cannot fit in a unit fails preparation instead of being omitted.

<details>
<summary>Structured-output argument limit</summary>

Preparation also splits batches whose reviewer schemas exceed 96 KiB after shell escaping, keeping them below the
launcher's argument-size limit. These batches count toward `maximum_batches`. If a single unit exceeds the schema limit,
preparation fails before model execution and asks for a smaller pull request. Allowed evidence lines are never
truncated.

</details>

## Budgets and Concurrency

The [central settings](#central-settings) define per-session spending and byte limits; [caller inputs](#caller-inputs)
define the maximum batch count. The configured per-run allocation is
`maximum_batches * reviewer_budget + verifier_budget`, when verification needs a model session. This is a session
allocation, not a provider-side account spending cap.

Reviewer jobs have a 90-minute timeout and run up to four batches concurrently; the verifier job also has a 90-minute
timeout. The example callers let active runs finish and keep the newest pending run. Merge-group events start a new
review of queued commits; new pushes and full reruns can also incur another review.

Each prompt states its turn budget. Reviewers must trace changed code through callers, validation, authentication,
authorization, and its resulting state change or external call. The verifier minimum leaves room to investigate even a
single finding. The PR title is explicitly untrusted metadata.

<details>
<summary>Turn-budget formulas</summary>

The reviewer budget is `min(120, max(40, 15 + 8 * units + ceil(bytes / 20,000)))`. The verifier budget is
`min(120, max(60, 12 + 6 * candidates))`.

</details>

See [provider spending controls](authentication.md#set-spending-controls) before broadening coverage. The model's
session budget does not constrain use of a credential outside the engine.

## Approve Dependency Sources

Use `allowedLockfileHosts` for approved private package registries. Use `allowedLockfileSources` for exact repository
origins using the `https://host/owner/repository` form. Add either value to the base branch in a separate reviewed
change. An unchanged source binding remains accepted, but base-lockfile hosts and origins do not authorize new bindings.

For example, an npm `gitlab:team/library#revision` or `https://gitlab.com/team/library#revision` source needs
`https://gitlab.com/team/library` in `allowedLockfileSources`; approving the `gitlab.com` host is insufficient. Composer
mirrors need the same host or repository approval as their transport requires. Unsupported mirror templates fail
preparation and cannot be enabled by a broader allowlist.

A label cannot approve a source. Use host approvals for registries and repository approvals for Git or GitHub archives;
approving a host does not authorize all repositories there. See the
[source-policy rules and limitations](security-model.md#dependency-source-policy) before changing an allowlist.

Store repository-specific assets, accepted risks, and threat models in the configured context files. Built-in profiles
describe reusable bug classes, while context explains what matters in this repository.
