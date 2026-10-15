# Changelog

For consumers evaluating an engine pin update; compare the reviewed revisions and read any migration requirements before
changing authentication trust or callers.

## Unreleased

Initial public engine interface:

- Reusable pull-request and merge-group security review, with verified findings, human-review notices, and sanitized
  diagnostics.
- Federation or an explicitly mapped API key, with full-SHA engine pins.
- Repository configuration for profiles, focus files, grouping, and dependency-source approvals.
- Caller inputs for batch limits and optional failure on verified findings; templates for ordinary PRs, labelled drafts,
  merge queues, and required reviews.

No public release revision is recorded yet. Future entries will describe consumer-visible behavior, compatibility
changes, and required migration steps. See the [release procedure](MAINTAINING.md#release-a-reviewed-revision).
