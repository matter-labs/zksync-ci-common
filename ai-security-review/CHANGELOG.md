# Changelog

For consumers evaluating an engine pin update; compare the reviewed revisions and read any migration requirements before
changing authentication trust or callers.

## Unreleased

Pre-release review fixes:

- Reject duplicate JSON/JSONC lockfile keys; apply npm and Bundler readers to `npm-shrinkwrap.json` and `gems.locked`.
- Enforce repository approval for recognized npm hosted Git sources and check Composer mirrors. Unsupported mirror
  templates or encodings now fail preparation and must be replaced with concrete supported URLs.
- Recheck separate source revision and package-identity changes; preserve human-review notices for changed explicit
  `npm:` alias targets, including substitutions that match their tarball paths.
- Neutralize backslash and protocol-relative Markdown link payloads in review comments.
- Set up Node.js 22 in every job, make machine ordering independent of ICU, and verify every engine checkout's SHA.

Initial public engine interface:

- Reusable pull-request and merge-group security review, with verified findings, human-review notices, and sanitized
  diagnostics.
- Federation or an explicitly mapped API key, with full-SHA engine pins.
- Repository configuration for profiles, focus files, grouping, and dependency-source approvals.
- Caller inputs for batch limits and optional failure on verified findings; templates for ordinary PRs, labelled drafts,
  merge queues, and required reviews.

No public release revision is recorded yet. Future entries will describe consumer-visible behavior, compatibility
changes, and required migration steps. See the [release procedure](MAINTAINING.md#release-a-reviewed-revision).
