import assert from "node:assert/strict";
import test from "node:test";
import { dependencyContextChunks, dependencyReviewSummary } from "../scripts/dependency-context.mjs";

test("dependency context budgets count every record without truncating or dropping residue", () => {
  const changes = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    file: "package-lock.json",
    reason: index % 2 ? "unclassified" : "recognized-source",
    after: { value: { name: `pkg-${index}`, version: "😀".repeat(300) } }
  }));
  const chunks = dependencyContextChunks(changes, 4_000);
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.ids),
    changes.map((change) => change.id)
  );
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk.text, "utf8") <= 4_000);
    assert.match(chunk.text, /untrusted data/u);
    for (const change of changes.filter((entry) => chunk.ids.includes(entry.id))) {
      assert.ok(chunk.text.includes(JSON.stringify(change, null, 2)));
    }
  }
  assert.deepEqual(dependencyReviewSummary(changes), { total: 100, recognized: 50, unclassified: 50 });
  assert.throws(() => dependencyContextChunks(changes, 1_000), /record exceeds the unit limit/u);
  assert.deepEqual(dependencyContextChunks([], 4_000), []);
});
