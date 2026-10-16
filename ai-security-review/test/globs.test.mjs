import assert from "node:assert/strict";
import test from "node:test";
import { matchesGlob } from "../scripts/globs.mjs";

test("glob matching handles recursive and single-segment patterns", () => {
  assert.equal(matchesGlob("**/*.sol", "Bridge.sol"), true);
  assert.equal(matchesGlob("**/*.sol", "l1/contracts/Bridge.sol"), true);
  assert.equal(matchesGlob("node/*/rpc.rs", "node/api/rpc.rs"), true);
  assert.equal(matchesGlob("node/*/rpc.rs", "node/api/internal/rpc.rs"), false);
  assert.equal(matchesGlob("node/**/rpc.?s", "node/api/internal/rpc.rs"), true);
  assert.equal(matchesGlob("src/[literal].js", "src/[literal].js"), true);
});

test("glob matching is bounded for overlapping wildcards", () => {
  assert.equal(matchesGlob(`${"*a".repeat(100)}b`, `${"a".repeat(500)}c`), false);
  assert.throws(() => matchesGlob("*".repeat(301), "src/file.ts"), /at most 300 characters/u);
});
