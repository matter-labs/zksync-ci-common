# Rust

Check unsafe blocks and FFI assumptions, integer and field conversions, panic or allocation paths reachable by untrusted
input, parsing ambiguity, concurrency and ordering bugs, nondeterminism, and state-machine invariant breaks.

Do not report ordinary panic possibilities unless an untrusted caller can trigger meaningful availability or state
impact. Safe Rust does not by itself prove protocol or application safety.
