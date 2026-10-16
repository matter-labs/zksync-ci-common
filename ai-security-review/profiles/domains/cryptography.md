# Cryptography

Check primitive and parameter selection, domain separation, transcript binding, randomness and nonce generation,
canonical encoding, curve and subgroup validation, field conversions, signature malleability, secret-dependent behavior,
and key generation, storage, rotation, and zeroization boundaries.

A finding must identify a concrete cryptographic property that fails and the attacker capability it enables. Do not
report custom cryptography or non-constant-time code without demonstrating that the changed path handles secrets or
security-critical verification.
