# Configure Anthropic Access

For organization administrators; start with a [verified engine revision](../README.md#verify-an-engine-revision),
authority to configure Anthropic, and access to the consumer's Actions settings.

Use a dedicated inference identity and spending workspace. Keep organization IDs, federation rule IDs, workspace
assignments, and local approval procedures in your organization's internal runbook. The public engine's identity remains
`matter-labs/zksync-ci-common`.

## Set Up Federation

Configure federation in the Claude Console following
[Anthropic's workload identity guide](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).
Use a dedicated service account and workspace with spending limits. Register the issuer
`https://token.actions.githubusercontent.com` and audience `https://api.anthropic.com`; grant inference access without
organization-administrator scope.

Expose these Actions variables to each consumer repository:

| Variable                       | Use                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_FEDERATION_RULE_ID` | Required federation rule ID.                                                                     |
| `ANTHROPIC_ORGANIZATION_ID`    | Required Anthropic organization UUID.                                                            |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | Set the intended service account explicitly; the pinned action also permits omission.            |
| `ANTHROPIC_WORKSPACE_ID`       | Set the spending workspace explicitly; omission is supported for a rule targeting one workspace. |

### Required Trust Conditions

The public reusable workflow can be called from repositories outside your organization. An eligible job can obtain an
OIDC token naming this engine in `job_workflow_ref`, even when the caller belongs to someone else. Standard repository
claims identify the caller; `job_workflow_ref` identifies the called engine. See
[GitHub's reusable-workflow OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows).

Federation, organization, service-account, and workspace IDs are identifiers, not credentials. Public consumers can
expose them in workflow files or logs. The federation rule must authorize the caller as well as the engine; identifier
secrecy does not protect your Anthropic budget.

Require all of the following conditions together:

| Claim                                    | Required condition                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `iss`                                    | `https://token.actions.githubusercontent.com`, with GitHub's signature verified by the registered issuer.                     |
| `aud`                                    | `https://api.anthropic.com`, matching the engine's configured audience.                                                       |
| `repository_owner_id` or `repository_id` | Your numeric `<owner-id>` or `<repository-id>`, matched exactly; replace the placeholder.                                     |
| `job_workflow_ref`                       | `matter-labs/zksync-ci-common/.github/workflows/ai-security-review.yaml@` followed by the reviewed full SHA, matched exactly. |
| `event_name`                             | `pull_request`; also permit `merge_group` only when using a merge-queue caller.                                               |

An owner-ID condition alone authorizes every repository in that organization that satisfies the other conditions. For
selected consumers, require both the owner ID and an explicit repository-ID allowlist. A `job_workflow_ref` condition
alone does not restrict caller identity. Anthropic also requires an organization or repository identity constraint for
shared issuers such as GitHub Actions; see its
[federation-rule requirements](https://platform.claude.com/docs/en/api/organization/federation/rules/create).

Verify actual claims rather than assuming a universal `sub` format. GitHub supports both name-based and immutable-ID
subjects; see [GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc). Update the exact
workflow trust reference whenever consumers change their engine pin, after
[verifying and reviewing the new revision](../README.md#verify-an-engine-revision). Exact-SHA trust does not establish
that the authorized commit belongs to the upstream branch or contains safe code. Keep the selected workspace and service
account explicit, and grant inference access without administrator scope.

### Verify the Federation Boundary

Before enabling review for consumers:

1. Run a same-repository PR in an authorized consumer, using a small reviewable change. Confirm successful OIDC
   authentication in both reviewer and verifier sessions; the latter needs a candidate to verify. Omit the API-key
   secret mapping and remove legacy key injection so key authentication cannot mask a federation failure.
2. From a repository you control outside the allowed organization, call the same engine SHA with the same federation
   variables. Use a same-repository PR there, not a fork PR, so the engine reaches authentication. The token exchange
   must fail because the caller's identity claims are unauthorized.
3. Confirm the rejection in Anthropic's authentication history. A skipped job, missing variable, or unrelated network
   failure does not demonstrate that the trust rule works. For a repository allowlist, also check an unapproved
   repository inside the allowed organization.

Do not print JWTs, exchanged access tokens, or API keys while checking claims. Engine CI uses dummy credentials and
cannot validate your federation configuration. OIDC replaces a persistent key with short-lived tokens; continue to
restrict trusted callers and monitor usage. See
[Anthropic's federation guide](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).

## Use an API Key

Create `ANTHROPIC_API_KEY` in the consumer repository's Actions secrets. Add only this named mapping under the reusable
job, alongside `with`:

```yaml
secrets:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Omit the mapping when using federation. Do not use `secrets: inherit`.

This is a long-lived credential used while processing untrusted PR content. A PR-modified caller or compromised job that
receives the key can disclose it. Log masking and model-tool restrictions do not guarantee that the key cannot leak.
Restrict who can modify workflows receiving secrets; see
[GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use). Required code-owner
approval protects merging workflow changes; it does not stop a PR's changed workflow from running before approval. Do
not treat CODEOWNERS as credential isolation.

Use a dedicated key and workspace for reviews, with provider-side spending limits. Monitor usage and unexpected cost
increases, configure alerts, and revoke and replace the key if exposure is suspected. The engine's session budget does
not limit an attacker using a stolen key outside the workflow. Prefer OIDC to avoid storing a persistent model
credential.

## Set Spending Controls

For either authentication method, configure provider-side workspace limits and usage alerts. Session budgets do not cap
aggregate spending across batches, reruns, pushes, or concurrent PRs. See the
[budget reference](configuration.md#budgets-and-concurrency) when choosing caller coverage.

Review the [job permission split](security-model.md#job-permissions) and
[data handling](security-model.md#data-handling) with the repository owner. Live federation checks must be run for your
actual trust rule; local engine tests do not establish that your configuration rejects unauthorized callers.

Return to [caller setup](../README.md#create-a-repository-caller) after authentication is configured.
