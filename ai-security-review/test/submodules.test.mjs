import assert from "node:assert/strict";
import test from "node:test";
import { assertGitlinkCoverage, changedGitlinks, gitlinks } from "../scripts/submodules.mjs";

const old = "a".repeat(40);
const next = "b".repeat(40);
const entry = (file, sha = old, mode = "160000") =>
  `${mode} ${mode === "160000" ? "commit" : "blob"} ${sha}\t${file}\0`;

test("tree comparison detects pointer, addition, deletion, rename and mode changes independently of diff configuration", () => {
  for (const [base, head, paths] of [
    [entry("lib/sub"), entry("lib/sub", next), ["lib/sub"]],
    ["", entry("lib/sub"), ["lib/sub"]],
    [entry("lib/sub"), "", ["lib/sub"]],
    [entry("lib/old"), entry("lib/new"), ["lib/new", "lib/old"]],
    [entry("lib/sub"), entry("lib/sub", next, "100644"), ["lib/sub"]],
    [entry("lib/sub", old, "100644"), entry("lib/sub", next), ["lib/sub"]]
  ]) {
    const changes = changedGitlinks(base, head);
    assert.deepEqual(
      changes.map((change) => change.path),
      paths
    );
    assert.throws(() => assertGitlinkCoverage(changes, []), /missing from review units/u);
    assertGitlinkCoverage(
      changes,
      paths.map((file) => ({ path: file }))
    );
  }
  assertGitlinkCoverage(changedGitlinks(entry("old"), entry("new")), [{ path: "new", oldPath: "old" }]);
  assert.deepEqual(changedGitlinks(entry("same"), entry("same")), []);
});

test("tree parsing preserves NUL-delimited paths and rejects malformed records", () => {
  assert.equal(gitlinks(entry("lib/tab\tand\nnewline")).get("lib/tab\tand\nnewline"), old);
  assert.throws(() => gitlinks("160000 commit invalid\tlib/sub\0"), /invalid tree entry/u);
});
