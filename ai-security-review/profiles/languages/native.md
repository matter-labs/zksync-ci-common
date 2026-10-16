# Native, LLVM, and GPU code

Check memory ownership and lifetime, bounds and alignment, integer conversions, undefined behavior, FFI contracts,
parser and decoder lengths, thread and device synchronization, host and device buffer agreement, unsafe optimizations,
and assumptions that differ across targets or build modes.

A finding must identify attacker-controlled data or a security-critical computation reaching the unsafe behavior. Do not
report theoretical undefined behavior without a reachable consequence.
