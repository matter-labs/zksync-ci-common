# Security Model

For security reviewers and adoption evaluators; read the [workflow overview](../README.md#how-it-works) first and use
the pinned engine revision when auditing implementation details.

## Pipeline

1. **Prepare:** read trusted configuration from the PR base commit and build the full local diff. Reconcile changed
   files, submodule pointers, dependency records, and review units before starting a model.
2. **Assign:** select universal, language, domain, and repository profiles. Split patches and group units into bounded
   batches without dropping changed records.
3. **Review:** give each batch the complete changed-file manifest, its unit assignments, trusted context, and bounded
   base snapshots. Require a disposition and changed-line citation for every assigned unit.
4. **Validate:** verify structured output and successful reads against the advertised units. Invalid paths, citations,
   inconsistent dispositions, missing artifacts, or incomplete coverage fail review.
5. **Verify:** challenge publishable candidates in a separate model session. When no candidate needs verification,
   finalization still produces a result without that model session.
6. **Publish and complete:** upload results, update the PR comment when applicable, and check completion and the
   configured finding policy. Merge groups publish artifacts; completion also runs after failures.

The [configuration reference](configuration.md) owns profile selection, batching, and budgets. The
[results guide](results.md) describes comment ownership, notices, stale heads, and recovery.

## Job Permissions

All jobs run in the consumer's Actions context. The caller grants the permissions needed by the reusable workflow; the
engine assigns them to separate jobs:

| Job                   | GitHub permissions                  | Anthropic access                                   |
| --------------------- | ----------------------------------- | -------------------------------------------------- |
| `prepare_cli`         | None.                               | None.                                              |
| `prepare`             | Contents read.                      | None.                                              |
| `review` and `verify` | Contents read; OIDC token issuance. | API key or federation when a model session starts. |
| `publish`             | Contents read; pull requests write. | None.                                              |
| `complete`            | Contents read.                      | None.                                              |

Reviewer and verifier jobs cannot write PR comments; the publisher cannot request an OIDC token. Permission separation
does not make an editable consumer caller trustworthy. See
[caller protection](required-review.md#protect-caller-changes) and [credential controls](authentication.md).

Every engine checkout uses the expected repository identity and `job.workflow_sha`, the server-resolved commit defining
the job. Each job rejects an unexpected repository or invalid SHA, then compares the engine checkout's actual HEAD with
that SHA before executing engine code. This is a checkout-integrity check; OIDC permission is granted at job level and
is not withheld by the comparison step.

When called for a fork PR, the engine skips plan preparation, review, verification, and publishing; completion fails as
unsupported. The uncredentialed CLI download still runs. GitHub normally withholds secrets from fork runs except a
read-only token, but repository settings determine secret availability; the engine's skip is not secret isolation. See
[GitHub's fork rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories).

Draft and label eligibility belong to the caller. A merge-group event triggers a new review of the queued commits
instead of trusting an earlier PR review.

## Execution Isolation

Reviewer and verifier launch Bun from fresh private directories outside the PR checkout, before credentials reach its
entrypoint. This prevents PR-controlled `bunfig.toml` preloads and `.env` files from affecting the launcher. Claude runs
in restricted and safe modes with Read, Grep, Glob, and the structured-output tool. Explicit denials cover commands,
file writes, agents, and network tools. Repository customizations remain disabled. Absolute Read denials protect `.git`
and the central engine, including symlinked access. Only source, plan, and required verification directories receive
additional read access. Credential files remain outside those roots. Prompts identify the absolute source checkout
because the session directory contains no repository files.

The engine checkout currently sits inside the source checkout. Credentialed engine entrypoints and their transitive
imports use only local modules and Node built-ins. CI follows static imports, re-exports, and literal dynamic imports;
computed imports fail the guard because their targets cannot be checked. This avoids resolving parser packages from
ancestor `node_modules`, but is not filesystem isolation. Moving the checkouts to sibling directories and revalidating
all paths remains a hardening follow-up.

## Coverage and Structured Output

Every unit must receive a disposition with a valid changed-line citation, and every finding must refer to its assigned
unit. The SDK can request corrections within the current session's budget. Independent validation also rejects
contradictions between a disposition and its findings.

Coverage counts successful returned lines, not requested ranges. Failed reads contribute nothing; successful retries and
overlapping partial reads can recover coverage. The pinned reader normalizes CRLF and includes a trailing empty line.
Coverage validation follows that exact returned-text format.

Plan artifacts use relative paths and include hidden base snapshots, including `.github/` and `.npmrc` when selected.
Consumers check advertised patches, context units, baselines, prompts, and manifests before use. Missing files fail
loading; explicit baseline omissions and empty baseline files remain valid.

<details>
<summary>Evidence and schema validation details</summary>

The reviewer schema uses an enum of changed source lines or anchors for each unit's evidence line. Nested constraints
bind finding paths and lines to units; root combinators are excluded because the API rejects them. Independent
validation checks disposition consistency before converting keyed output into candidate artifacts.

Read coverage matches successful tool results to their calls and checks returned text against every patch and
dependency-context line. Generated code, migrations, documentation, and tests are covered too. A synthetic empty entry
after a terminal newline is optional; actual blank lines and all other content remain mandatory.

</details>

## Diff and Submodule Integrity

Git attributes come from the pull request base commit through `--attr-source`. Diffs disable text conversion and use
literal pathspecs. Only a direct NUL-byte probe classifies a blob as binary, so `-diff` attributes cannot hide text. A
binary blob without a known binary extension fails preparation. Text remains reviewable even when its extension normally
denotes a binary asset. Pure renames and mode changes become synthetic metadata units. Base snapshots come from the pull
request merge base.

Submodule diffs use `--ignore-submodules=none`, regardless of the PR's `.gitmodules` settings. Preparation independently
compares mode-160000 entries from the merge-base and head trees, including additions, deletions, renames, and mode
changes. A missing review unit fails preparation. `submodule_changes` preserves before/after pointers in the result
artifact. Submodule code is not fetched or reviewed; pointer changes produce a human-review notice. Ordinary `ignore`
settings are not prohibited when the forced diff and independent coverage check succeed.

## Dependency Source Policy

Source policy checks changed, recognized source bindings against approved hosts and exact repository origins. Unchanged
bindings remain accepted but do not authorize new bindings elsewhere. Cargo, Poetry, uv, and Composer bindings include
package identity; separate Composer and Poetry source revision fields are also compared. Reordering package arrays alone
does not create new bindings. [Source approvals](configuration.md#approve-dependency-sources) must land on the base
branch in a separate reviewed change.

Git sources require exact repository approval, including sources on otherwise approved registry hosts. Public Git SSH
URLs may use the transport username `git`; passwords and other usernames remain rejected. HTTPS URLs cannot contain
credentials. GitHub archive URLs on `github.com`, `api.github.com`, `codeload.github.com`, and
`raw.githubusercontent.com` require the corresponding `https://github.com/owner/repository` approval. A host approval
cannot bypass that check. Opaque GitHub asset URLs cannot establish a repository origin and fail closed. GitHub URLs
with encoded paths or nonstandard ports also fail closed.

npm-family lockfiles use npm's `hosted-git-info` parser for recognized hosted Git URLs and shorthands such as
`gitlab:owner/repository` and `github:owner/repository`. A GitLab HTTPS repository URL needs exact repository approval
even without a `.git` suffix; an arbitrary HTTPS archive ending in `.git` is not automatically Git. Hosted Git parsing
is bounded to 4,096 characters; oversized known hosted references fail preparation instead of inheriting a host
approval.

Composer `source.mirrors` and `dist.mirrors` are checked alongside primary URLs, using their parent's transport type and
revision. Supported mirrors use absolute network URLs with `git`, `zip`, or `tar` types. Templates, percent-encoded
mirror URLs, local paths, and unsupported forms fail preparation; expand templates to concrete URLs before adopting this
check.

Both `registry.npmjs.org` and `registry.yarnpkg.com` require standard HTTPS. For `package-lock.json`,
`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `bun.lock`, and Yarn Classic, recognized package identities must match the
tarball's package path. Identity comes from lockfile declarations, never the download URL. Declared aliases use the
resolved target name, not the installed alias. Changed explicit `npm:` alias targets receive
`reviewNotice: "alias-target-change"` and remain unclassified, even when their tarball matches the declared target. This
is a human-review signal; registry or trusted-manifest validation of alias intent remains outside the engine's checks.

AI review cannot override deterministic policy violations. Unclassified records alone neither fail the workflow nor
establish a vulnerability or source approval. They remain in `result.json` and produce a human-review notice even when
AI confirms no findings. See the [notice guidance](results.md#investigate-human-review-notices).

<details>
<summary>Lockfile parser and dependency-context details</summary>

pnpm keys support scopes, parenthesized peer suffixes, and legacy slash-separated versions. Bun uses package-tuple
descriptors; Yarn Classic uses dependency selectors, including grouped selectors and `npm:` aliases.

The pnpm, Bun, and Yarn descriptor readers cap inputs at 4,096 characters and package names at 214 characters.
Unsupported or ambiguous identities remain unclassified; host, origin, protocol, and credential rules still apply. Other
lockfile formats do not receive npm package-identity checks. These checks compare lockfile declarations with tarball
paths; they do not verify archive contents or establish that a dependency substitution was intended.

The canonical Cargo registry source `registry+https://github.com/rust-lang/crates.io-index` remains approved as a
registry, not as blanket GitHub trust.

Lockfile validation decodes JSON, JSONC, YAML, TOML, and Yarn Classic sources before applying policy. Bundler remote
entries (`Gemfile.lock` and `gems.locked`) and Go checksum files use format-specific readers. `npm-shrinkwrap.json` uses
the npm reader throughout detection, source policy, and dependency context. JSON and JSONC reject duplicate decoded
keys, including nested and escaped keys, with bounded depth and record counts. Unsupported or malformed formats fail
without a raw-text fallback. The preparation job installs integrity-pinned production parsers with lifecycle scripts
disabled; test-only dependencies are omitted. Reviewer and verifier jobs do not install these dependencies.

Preparation records changed dependency entries and unmodeled lockfile sections in the manifest's `dependency_changes`.
Each record carries its location, package name when known, classification, and bounded before/after summaries. Entries
without a recognized primary source or required package identity receive `reason: "unclassified"`, including
dependencies that omit URLs or use implicit registries. Covered residue includes unsupported compound Yarn Git
selectors, `exec:`, and `patch:` locators, pnpm and Bun aliases, structured Nix inputs, Go checksums, and local archive
references. Changed selectors and format controls also receive records. Lockfile moves between packages retain review
context.

Dedicated `dependency-context` units deliver these records to the `domains/ci-supply-chain` reviewer alongside the
original patch units. Summaries redact known secret patterns and omit URL credentials, queries, and fragments. Large
values receive explicit omission notices pointing back to original patches. Context units count toward byte, unit,
batch, and turn budgets; exceeding a limit fails completeness rather than dropping entries. Validation checks batch
assignments, context-content digests, and successful reads of every patch and context unit. The manifest links context
records to their review units and original patches.

</details>

## Claude CLI Supply Chain

Every engine job explicitly sets up the central Node.js major version before running scripts. The same setting reaches
the base action, avoiding its Node 18 fallback. Machine ordering uses UTF-16 code-unit comparisons, so differing ICU
versions cannot reorder findings between finalization and publication.

The workflow pins Anthropic's base action for authentication and SDK execution, but an action pin alone would not pin
bytes downloaded by its default mutable installer. The engine supplies its own verified Claude executable instead. This
verification does not cover Bun or the launcher's npm dependency graph: the pinned base action still uses `setup-bun`
and `bun install --production` without `--frozen-lockfile`. Independently verifying that tooling remains a follow-up; do
not interpret the Claude digest check as verification of the entire execution environment.

`prepare_cli` downloads the configured native Linux x64 tarball, verifies its SHA-512 digest, and checks `--version` and
`--help`. It has no repository permissions, OIDC minting permission, or Anthropic credentials. It uploads the unchanged
tarball as a same-run artifact; a failed check prevents model jobs from starting.

Every reviewer and verifier job independently verifies that archive against the same workflow-level digest before
extraction. The archive preserves executable permissions, and a missing executable or execute bit fails the job. The
action receives `path_to_claude_code_executable`, bypassing its remote installer; background and manual updates are
disabled.

All artifact uploads replace same-run artifacts on reruns. Maintainers must change the CLI version, URL, and integrity
pin together through the protected review process; see [upgrade validation](../MAINTAINING.md#dependency-updates). The
base action accepts PR and merge-group events without needing a GitHub token or processing untrusted issue metadata
itself.

## Prompt-Injection Signals

Deterministic injection checks scan the title and review units, plus repository data returned by Read, Grep, and Glob.
They flag instruction overrides and forced review output, including signals in unchanged context read by the model.
Warnings survive a CLEAN disposition and skipped candidate verification. The model cannot remove them. Trusted generated
prompts are excluded from tool-result scanning; repository documentation and test fixtures may still trigger warnings.
Standalone `CLEAN`, `unit_reviews`, or `StructuredOutput` identifiers do not trigger warnings. Patterns use fixed
vocabulary and bounded windows; adversarial multi-megabyte tests check scanner termination. Warnings remain advisory;
see [notice handling](results.md#investigate-human-review-notices) and the [limitations](#limitations).

## Secret Redaction

Reviewer and verifier prompts require file and line references plus the suspected secret type, never the value. This
instruction also forbids partial, encoded, or transformed copies in output fields and tool arguments.

Deterministic redaction covers URL userinfo, known AWS, Google, GitHub, GitLab, npm, Slack, API-key, and bearer-token
patterns, plus JSON Web Tokens (JWTs). It also removes complete or truncated PEM private-key bodies and explicitly
labelled scalar mnemonic, seed-phrase, private-key, and AWS secret-key assignments. URL-userinfo removal includes
percent-encoded credentials. These rules do not classify arbitrary base64 strings as secrets. Standalone Ethereum
addresses, commit hashes, digests, and hashed paths remain intact; hex values inside recognized credential contexts
still undergo redaction.

Validation checks canonical paths and identifiers without redacting or trimming them. Public rendering redacts displayed
strings without changing internal paths or fingerprints. The publisher regenerates the comment from `result.json` and
rejects mismatched comment artifacts before posting or updating them. Redaction uses literal patterns and forward scans
with an 8,000-character input limit. No AI secret-detection pass runs on the publication path.

## Data Handling

Consumer source and selected context reach Anthropic. Provider retention follows the consumer organization's configured
terms; the engine makes no universal retention promise. GitHub artifacts use the
[central retention setting](configuration.md#central-settings).

> **Public repositories:** If your repository is public, anyone can see the review comment, and anyone signed in to
> GitHub can
> [download the run's artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
> Candidate artifacts include the suspected issues the AI reported, even ones later rejected during verification, with
> attack details. A finding can also describe a weakness in code that is already deployed, not only in the PR. **Fix
> vulnerabilities in deployed code privately, not in a public PR.**

Comments, summaries, and artifacts inherit the consumer repository's visibility. Plans contain source patches, canonical
paths, dependency context, and bounded base snapshots. Sanitized diagnostics omit raw transcripts and arbitrary error
text, but other artifacts still contain repository data.

<details>
<summary>Sanitized session error classification</summary>

Classification uses bounded error prefixes and SDK error codes. A recognized
`tools.<one-or-two-digit index>.custom.input_schema` prefix supplies an optional field, and an exact known root-schema
rejection supplies `unsupported-root-schema-combinator`. Unrecognized errors remain `session-execution-error`.

Provider headers and request IDs are not captured. Diagnostics omit source snippets, credentials, and arbitrary model
error text; numeric metrics and allowlisted categories remain available. See
[diagnostic interpretation](results.md#inspect-artifacts-and-diagnostics).

</details>

## Limitations

- **Incomplete detection:** verification checks reported candidates, not units declared CLEAN. Read coverage proves
  delivery, not comprehension or exhaustive review.
- **Model variability:** fresh reviews can omit earlier findings. There is no persistent unresolved-finding ledger; use
  the [rerun guidance](results.md#recover-from-a-failed-review).
- **Prompt injection:** the scanner recognizes bounded signals, can flag benign content, and can miss attacks. Notices
  remain advisory even in findings-enforcement mode.
- **Dependency semantics:** checks cover documented encodings, not full package-manager behavior. Go replacements,
  registry configuration, and local binary archive contents have gaps; tarball identity checks do not inspect downloaded
  contents.
- **Submodules and binaries:** gitlink changes are recorded, but submodule code is not fetched. Known binary assets can
  skip textual review.
- **Redaction:** custom credential formats, unlabelled mnemonics, encodings, and structured secrets can escape
  detection. Prompt instructions cannot guarantee secrecy, and human review cannot undo an already-published disclosure.
- **Caller trust:** repository-owned workflows can be edited and executed before merge approval. CODEOWNERS does not
  provide runtime isolation; federation rules and Actions permissions must be configured independently.

Keep repository-specific threat models and accepted risks in the consumer's trusted context, not in shared engine
profiles. Report engine vulnerabilities through the repository's [security policy](../../SECURITY.md).
