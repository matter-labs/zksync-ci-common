import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateRepositoryConfig } from "../scripts/repository-config.mjs";
import {
  changedLineRanges,
  manifestDirectories,
  groupForPath,
  parseChangedLines,
  splitPatch,
  packUnitsIntoBatches,
  reviewerTurnBudget,
  verifierTurnBudget
} from "../scripts/review-planning.mjs";

const profilesRoot = fileURLToPath(new URL("../profiles", import.meta.url));

test("changed source lines are compacted into inclusive ranges without filling gaps", () => {
  const lines = [1, 4, 5, 6, 12, 14, 15];
  assert.deepEqual(changedLineRanges(lines), [
    [1, 1],
    [4, 6],
    [12, 12],
    [14, 15]
  ]);
  assert.deepEqual(lines, [1, 4, 5, 6, 12, 14, 15]);
  assert.deepEqual(changedLineRanges([]), []);
  assert.deepEqual(changedLineRanges(Array.from({ length: 1500 }, (_, index) => index + 1)), [[1, 1500]]);
});

test("changed-line parsing includes additions and deletion anchors", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -8,4 +8,4 @@",
    " context",
    "-removed",
    "+added",
    " context"
  ].join("\n");
  assert.deepEqual(parseChangedLines(patch), [9]);
});

test("large patches are split into bounded review units", () => {
  const fileHeader = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts"];
  const hunks = Array.from({ length: 3 }, (_, hunk) => [
    `@@ -${hunk * 400 + 1},0 +${hunk * 400 + 1},400 @@`,
    ...Array.from({ length: 400 }, (_, index) => `+changed line ${hunk}-${index}`)
  ]);
  const patch = [...fileHeader, ...hunks.flat()].join("\n");
  const chunks = splitPatch(patch, 10_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.match(chunk, /^diff --git/u);
    assert.match(chunk, /^@@/mu);
    assert.ok(parseChangedLines(chunk).length > 0);
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 10_000);
  }
});

test("a single oversized hunk is split by line range", () => {
  const patch = [
    "diff --git a/src/large.ts b/src/large.ts",
    "--- /dev/null",
    "+++ b/src/large.ts",
    "@@ -0,0 +1,30000 @@",
    ...Array.from({ length: 30_000 }, (_, index) => `+export const value_${index} = ${index};`)
  ].join("\n");
  const chunks = splitPatch(patch, 80_000);
  assert.ok(chunks.length > 10);
  assert.equal(
    chunks.reduce((total, chunk) => total + parseChangedLines(chunk).length, 0),
    30_000
  );
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 80_000));
  assert.ok(chunks.every((chunk) => chunk.split("\n").length <= 2_000));
});

test("batch packing enforces both byte and schema unit limits without losing or mutating units", () => {
  let seed = 1844;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (const count of [0, 1, 199, 200, 201, 400, 401, 4801]) {
    for (const groupCount of [1, 7, 201]) {
      for (const small of [true, false]) {
        const units = Array.from({ length: count }, (_, index) => ({
          id: "unit-" + String(index).padStart(5, "0"),
          group: String(next() % groupCount),
          bytes: small ? 300 : 1 + (next() % 79999)
        }));
        const original = structuredClone(units);
        const batches = packUnitsIntoBatches(units, 160000);
        assert(
          batches.every((batch) => batch.length <= 200 && batch.reduce((sum, unit) => sum + unit.bytes, 0) <= 160000)
        );
        assert.deepEqual(
          batches
            .flat()
            .map((unit) => unit.id)
            .sort(),
          units.map((unit) => unit.id).sort()
        );
        assert.deepEqual(packUnitsIntoBatches(units, 160000), batches);
        assert.deepEqual(units, original);
      }
    }
  }
});

test("turn budgets scale with work and stay bounded", () => {
  assert.equal(reviewerTurnBudget(1), 40);
  assert.equal(reviewerTurnBudget(4), 47);
  assert.equal(reviewerTurnBudget(30), 120);
  assert.equal(reviewerTurnBudget(1, 160_000), 40);
  assert.equal(verifierTurnBudget(1), 60);
  assert.equal(verifierTurnBudget(8), 60);
  assert.equal(verifierTurnBudget(9), 66);
  assert.equal(verifierTurnBudget(10), 72);
  assert.equal(verifierTurnBudget(18), 120);
  assert.equal(verifierTurnBudget(50), 120);
  assert.throws(() => reviewerTurnBudget(-1), /non-negative/u);
});

test("nearest manifest grouping handles era-style trees and configured roots", () => {
  const manifests = manifestDirectories([
    "Cargo.toml",
    "core/lib/crypto/Cargo.toml",
    "core/node/api/Cargo.toml",
    "apps/web/package.json"
  ]);
  assert.equal(groupForPath("core/lib/crypto/src/hash.rs", manifests), "core/lib/crypto");
  assert.equal(groupForPath("core/node/api/src/rpc.rs", manifests), "core/node/api");
  assert.equal(groupForPath("core/bin/tool/main.rs", manifests), "core");
  assert.equal(groupForPath("apps/web/src/main.ts", manifests), "apps/web");
  assert.equal(groupForPath("README.md", manifests), ".");
  assert.equal(groupForPath("prover/circuits/a.rs", manifests, ["prover", "prover/circuits"]), "prover/circuits");
  const config = validateRepositoryConfig({ version: 1, groupRoots: ["core/lib"] }, profilesRoot);
  assert.deepEqual(config.groupRoots, ["core/lib"]);
  assert.throws(
    () => validateRepositoryConfig({ version: 1, groupRoots: ["../outside"] }, profilesRoot),
    /unsafe group root/u
  );
});

test("groups are bin-packed into batches and split only when oversized", () => {
  const unit = (id, group, bytes) => ({ id, group, bytes });
  const tiny = Array.from({ length: 30 }, (_, index) =>
    unit(`unit-${String(index + 1).padStart(4, "0")}`, `crate-${index}`, 400)
  );
  assert.equal(packUnitsIntoBatches(tiny, 20_000).length, 1);

  const oversized = [unit("unit-0001", "big", 9_000), unit("unit-0002", "big", 9_000), unit("unit-0003", "big", 9_000)];
  assert.equal(packUnitsIntoBatches(oversized, 10_000).length, 3);

  const mixed = [
    unit("unit-0001", "a", 7_000),
    unit("unit-0002", "a", 2_000),
    unit("unit-0003", "b", 3_000),
    unit("unit-0004", "c", 1_000)
  ];
  const batches = packUnitsIntoBatches(mixed, 10_000);
  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.ok(batch.reduce((total, entry) => total + entry.bytes, 0) <= 10_000);
    const groups = batch.map((entry) => entry.group);
    assert.deepEqual(
      groups,
      [...groups].sort((left, right) => groups.indexOf(left) - groups.indexOf(right))
    );
  }
  assert.ok(packUnitsIntoBatches(mixed, 10_000)[0].some((entry) => entry.group === "a"));
  assert.throws(() => packUnitsIntoBatches([unit("unit-0001", "big", 10_001)], 10_000), /exceeds/u);
});
