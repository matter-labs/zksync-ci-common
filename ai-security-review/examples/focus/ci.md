Applies to .github/**, deployments/**, and Dockerfiles at any directory level.

# CI Security Review Focus

- Check workflow permissions and credential exposure to untrusted pull requests.
- Keep untrusted changes from controlling privileged build or deployment steps.
- Verify dependency sources and pinned action and container references.

Replace these invariants with the repository's actual build, deployment, credential, and approval boundaries.
