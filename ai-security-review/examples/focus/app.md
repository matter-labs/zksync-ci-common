Applies to application and library source code.

# Application Security Review Focus

- Enforce authorization before reading or changing user-owned data.
- Reject expired or revoked credentials before processing authenticated requests.
- Keep account identifiers bound to the authenticated principal through storage and response serialization.
- Check low-resource denial-of-service paths in request parsing, authentication, and background work.

Replace these service-oriented invariants with the repository's actual assets, trust boundaries, and accepted risks.
