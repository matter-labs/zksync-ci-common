import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseChangedLines, splitPatch } from "../scripts/review-planning.mjs";

const HEADER = "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n";
const NO_NEWLINE = "\\ No newline at end of file";

function changedRecords(patch) {
  const records = [];
  let hunk;
  const finish = () => {
    if (!hunk) return;
    assert.equal(hunk.oldSeen, hunk.oldCount);
    assert.equal(hunk.newSeen, hunk.newCount);
  };
  for (const line of patch.replace(/\n$/u, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      hunk = undefined;
    } else if (line.startsWith("@@")) {
      finish();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      assert.ok(match);
      const oldCount = Number(match[2] ?? 1);
      const newCount = Number(match[4] ?? 1);
      hunk = {
        old: Number(match[1]) + (oldCount === 0 ? 1 : 0),
        new: Number(match[3]) + (newCount === 0 ? 1 : 0),
        oldCount,
        newCount,
        oldSeen: 0,
        newSeen: 0
      };
    } else if (hunk && line === NO_NEWLINE) {
      if (hunk.lastChanged) records.at(-1).noNewline = true;
    } else if (hunk) {
      assert.ok(["+", "-", " "].includes(line[0]));
      hunk.lastChanged = line[0] !== " ";
      if (hunk.lastChanged) records.push({ text: line, old: hunk.old, new: hunk.new, noNewline: false });
      if (line[0] !== "+") {
        hunk.old += 1;
        hunk.oldSeen += 1;
      }
      if (line[0] !== "-") {
        hunk.new += 1;
        hunk.newSeen += 1;
      }
    }
  }
  finish();
  return records;
}

function assertSplit(patch, maximumBytes = 10_000) {
  const chunks = splitPatch(patch, maximumBytes);
  assert.ok(chunks.length > 0);
  assert.deepEqual(chunks.flatMap(changedRecords), changedRecords(patch));
  assert.deepEqual(
    [...new Set(chunks.flatMap(parseChangedLines))].sort((a, b) => a - b),
    parseChangedLines(patch)
  );
  for (const chunk of chunks) {
    assert.ok(changedRecords(chunk).length > 0);
    assert.ok(Buffer.byteLength(chunk, "utf8") <= maximumBytes);
    assert.ok(chunk.trimEnd().split("\n").length <= 1_500);
  }
  return chunks;
}

function conversionSection(mode, lines, added) {
  const header = [
    "diff --git a/lib/sub b/lib/sub",
    `${added ? "new" : "deleted"} file mode ${mode}`,
    `index ${added ? "0000000..1234567" : "1234567..0000000"}`
  ];
  if (lines.length) {
    header.push(
      `--- ${added ? "/dev/null" : "a/lib/sub"}`,
      `+++ ${added ? "b/lib/sub" : "/dev/null"}`,
      added ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
      ...lines.map((line) => `${added ? "+" : "-"}${line}`)
    );
  }
  return `${header.join("\n")}\n`;
}

test("submodule/file conversions preserve both patch sections, headers and all changed records", () => {
  for (const fileLines of [
    ["ordinary file", "diff --git a/inside b/inside", "@@ source text"],
    Array.from({ length: 4 }, (_, index) => `${index}${"x".repeat(5_000)}`)
  ]) {
    for (const fromSubmodule of [true, false]) {
      const sections = [
        conversionSection(
          fromSubmodule ? "160000" : "100644",
          fromSubmodule ? ["Subproject commit abc"] : fileLines,
          false
        ),
        conversionSection(
          fromSubmodule ? "100644" : "160000",
          fromSubmodule ? fileLines : ["Subproject commit def"],
          true
        )
      ];
      const chunks = assertSplit(sections.join(""));
      assert.deepEqual(
        parseChangedLines(sections.join("")),
        Array.from({ length: fromSubmodule ? fileLines.length : 1 }, (_, index) => index + 1)
      );
      const deletion = chunks.filter((chunk) => chunk.includes("deleted file mode"));
      const addition = chunks.filter((chunk) => chunk.includes("new file mode"));
      assert.ok(deletion.length > 0 && addition.length > 0);
      assert.deepEqual(deletion.flatMap(changedRecords), changedRecords(sections[0]));
      assert.deepEqual(addition.flatMap(changedRecords), changedRecords(sections[1]));
      assert.ok(deletion.every((chunk) => chunk.includes("+++ /dev/null\n")));
      assert.ok(addition.every((chunk) => chunk.includes("--- /dev/null\n")));
    }
  }
});

test("empty-file conversions retain metadata-only sections without inventing changed lines", () => {
  for (const fromSubmodule of [true, false]) {
    const sections = [
      conversionSection(fromSubmodule ? "160000" : "100644", fromSubmodule ? ["Subproject commit abc"] : [], false),
      conversionSection(fromSubmodule ? "100644" : "160000", fromSubmodule ? [] : ["Subproject commit def"], true)
    ];
    assert.deepEqual(splitPatch(sections.join(""), 10_000), sections);
    assert.deepEqual(parseChangedLines(sections.join("")), [1]);
    assert.deepEqual(parseChangedLines(sections[fromSubmodule ? 1 : 0]), []);
  }
});

test("long leading, trailing and intervening context never becomes an evidence-free unit", () => {
  const context = Array.from({ length: 40 }, (_, i) => ` ${i}${"x".repeat(5_000)}\n`).join("");
  const patch = `${HEADER}@@ -1,122 +1,122 @@\n${context}-before\n+after\n${context}-before2\n+after2\n${context}`;
  const chunks = assertSplit(patch, 80_000);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].includes(` 39${"x".repeat(5_000)}`));
});

test("oversized unchanged lines are discarded without losing changes or joining discontinuous ranges", () => {
  const hugeContext = ` ${"x".repeat(20_000)}\n`;
  const patch = `${HEADER}@@ -1,5 +1,5 @@\n${hugeContext}-before\n+after\n${hugeContext}-before2\n+after2\n${hugeContext}`;
  const chunks = assertSplit(patch);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map(parseChangedLines), [[2], [4]]);
});

test("insertions, deletions, replacements and multiple hunks preserve ordered records and zero-count coordinates", () => {
  const removed = `-${"r".repeat(5_000)}\n`;
  const added = `+${"a".repeat(5_000)}\n`;
  for (const hunk of [
    `@@ -0,0 +1,3 @@\n${added.repeat(3)}`,
    `@@ -7,0 +8,3 @@\n${added.repeat(3)}`,
    `@@ -1,3 +0,0 @@\n${removed.repeat(3)}`,
    `@@ -8,3 +7,0 @@\n${removed.repeat(3)}`,
    `@@ -8,3 +8,3 @@\n${removed.repeat(3)}${added.repeat(3)}`,
    `@@ -8,1 +8,1 @@\n${removed}${added}@@ -31,1 +31,2 @@ function example()\n${removed}${added.repeat(2)}`
  ])
    assertSplit(HEADER + hunk);
});

test("no-newline markers stay attached to their changed records across splits", () => {
  const changed = "x".repeat(5_000);
  const patch = `${HEADER}@@ -8 +8 @@\n-${changed}\n${NO_NEWLINE}\n+${changed}\n${NO_NEWLINE}\n`;
  const chunks = assertSplit(patch);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.endsWith(`${NO_NEWLINE}\n`)));
  assertSplit(`${HEADER}@@ -8,2 +8 @@\n-before\n unchanged\n${NO_NEWLINE}\n`);
});

test("UTF-8 headers, suffixes, markers and body bytes count toward exact unit limits", () => {
  const unicodeHeader = HEADER.replaceAll("example", "日本語");
  const prefix = `${unicodeHeader}@@ -0,0 +1,1 @@ é\n+`;
  const suffix = `\n${NO_NEWLINE}\n`;
  const remaining = 10_000 - Buffer.byteLength(prefix + suffix);
  const payload = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  const patch = prefix + payload + suffix;
  assert.equal(Buffer.byteLength(assertSplit(patch)[0]), 10_000);
  assert.throws(() => splitPatch(`${prefix}${payload}x${suffix}`, 10_000), /single diff line/u);
});

test("line-limited splitting counts generated headers and does not drop repeated changes", () => {
  assertSplit(`${HEADER}@@ -0,0 +1,4000 @@\n${"+same\n".repeat(4_000)}`, 80_000);
});

test("mixed records preserve coordinates and significant whitespace across varying byte boundaries", () => {
  let seed = 1844;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let fixture = 0; fixture < 60; fixture += 1) {
    const lines = Array.from({ length: 80 }, () => {
      const marker = [" ", "-", "+"][next() % 3];
      const size = [1, 100, 2_000, 4_000][next() % 4];
      return `${marker}${"é".repeat(size)}  \n`;
    });
    const oldCount = lines.filter((line) => !line.startsWith("+")).length;
    const newCount = lines.filter((line) => !line.startsWith("-")).length;
    assertSplit(`${HEADER}@@ -999,${oldCount} +9999,${newCount} @@\n${lines.join("")}`, 10_000 + (next() % 10_000));
  }
});

test("splitting many short records has bounded execution time", () => {
  const moduleUrl = new URL("../scripts/review-planning.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { splitPatch } from ${JSON.stringify(moduleUrl)};
    const patch = ${JSON.stringify(HEADER)} + '@@ -0,0 +1,100000 @@\\n' + '+x\\n'.repeat(100000);
    const chunks = splitPatch(patch, 80000);
    assert.ok(chunks.length > 60);
    const section = ${JSON.stringify(HEADER)} + '@@ -0,0 +1,1 @@\\n+x\\n';
    assert.equal(splitPatch(section.repeat(20000), 80000).length, 20000);
  `
    ],
    { encoding: "utf8", timeout: 5_000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
