# Wallets and transaction signing

Check that displayed intent matches the signed payload, including chain and domain IDs, nonce and replay boundaries,
transaction serialization, signer and provider selection, account and session-key scope, permits and allowances,
approval targets, callback origins, and key material in storage, logs, errors, and IPC.

A finding must show how an attacker causes unintended authority, signature, transaction, or asset movement. Do not treat
an explicit user approval as protection when the approved representation differs from the signed payload.
