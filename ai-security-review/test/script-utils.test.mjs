import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPatchReadCoverage, readExecutionOutput } from "../scripts/script-utils.mjs";
import { readTrace } from "./read-trace.mjs";

function fixture(t, content = "first\nsecond\n") {
  const directory = mkdtempSync(path.join(tmpdir(), "review-read-coverage-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const file = path.join(directory, "unit.patch");
  writeFileSync(file, content);
  const batch = { units: [{ id: "unit-0001", patchFile: "unit.patch", lines: content.split("\n").length }] };
  return { file, check: (messages) => assertPatchReadCoverage(messages, batch, directory) };
}

test("structured output from an unsuccessful session cannot be finalized", (t) => {
  const { file } = fixture(t);
  for (const outcome of [{ subtype: "error_max_turns", is_error: true }, { subtype: "success" }]) {
    writeFileSync(file, JSON.stringify([{ type: "result", ...outcome, structured_output: { findings: [] } }]));
    assert.throws(() => readExecutionOutput(file, "fixture"), /did not complete successfully/u);
  }
});

test("coverage uses returned lines, not a requested range exceeding the actual result", (t) => {
  const { file, check } = fixture(t, Array.from({ length: 2100 }, (_, index) => "line " + index).join("\n"));
  assert.throws(() => check(readTrace(file, { limit: 100_000 })), /returned 2000 of 2100/u);
  check([...readTrace(file), ...readTrace(file, { id: "remainder", offset: 2001, limit: 100 })]);
});

test("coverage preserves CRLF normalization, trailing empty lines and long lines", (t) => {
  const { file, check } = fixture(t, "first\r\n" + "x".repeat(75_000) + "\r\n");
  check(readTrace(file));
});

test("coverage accepts omission of only the synthetic EOF entry, preserving real blank lines", (t) => {
  const { file, check } = fixture(t, "first\n\n");
  check(readTrace(file, { limit: 2 }));
  assert.throws(
    () => check(readTrace(file, { limit: 1 })),
    (error) => {
      assert.deepEqual(error.diagnostics, { code: "incomplete-read", unit_id: "unit-0001", missing_ranges: [[2, 2]] });
      return true;
    }
  );
  const noNewline = fixture(t, "first\nlast");
  assert.throws(() => noNewline.check(readTrace(noNewline.file, { limit: 1 })), /missing ranges \[\[2,2\]\]/u);
});

test("failed, absent, truncated, invalid and nested read evidence cannot satisfy coverage", (t) => {
  const { file, check } = fixture(t);
  const mutations = [
    (trace) => {
      trace[1].message.content[0].is_error = true;
    },
    (trace) => {
      trace.pop();
    },
    (trace) => {
      trace[1].message.content[0].content = "1\tfirst\n2\tsec...[truncated]";
    },
    (trace) => {
      trace[0].message.content[0].input.limit = "all";
    },
    (trace) => {
      trace[0].message.content[0].input.offset = 0;
    },
    (trace) => {
      trace[0].message.content[0].input.limit = -1;
    },
    (trace) => {
      trace[0].message.content[0].input.file_path = "unit.patch";
    },
    (trace) => {
      trace[1].message.content[0].content = "1\twrong\n2\tsecond\n3\t";
    },
    (trace) => {
      for (const message of trace) message.parent_tool_use_id = "agent";
    }
  ];
  for (const mutate of mutations) {
    const trace = readTrace(file);
    mutate(trace);
    assert.throws(() => check(trace), /review coverage mismatch/u);
  }
  assert.throws(
    () => check([{ type: "result", structured_output: { nested: readTrace(file) } }]),
    /coverage mismatch/u
  );
  assert.throws(
    () => check([{ type: "user", message: { role: "user", content: [{ type: "text", nested: readTrace(file) }] } }]),
    /coverage mismatch/u
  );
});

test("successful retries and overlapping reads recover coverage", (t) => {
  const { file, check } = fixture(t);
  const failed = readTrace(file, { id: "failed" });
  failed[1].message.content[0].is_error = true;
  check([
    ...failed,
    ...readTrace(file, { id: "start", limit: 2 }),
    ...readTrace(file, { id: "end", offset: 2, limit: 2 })
  ]);
});

test("duplicate, out-of-order and cross-ID tool results fail closed", (t) => {
  const { file, check } = fixture(t);
  const trace = readTrace(file);
  assert.throws(() => check([...trace].reverse()), /preceding/u);
  assert.throws(() => check([...trace, trace[1]]), /preceding/u);
  assert.throws(() => check([...trace, ...trace]), /duplicate/u);
  trace[1].message.content[0].tool_use_id = "other";
  assert.throws(() => check(trace), /preceding/u);
});

test("coverage resolves canonical patch paths and does not trust the declared line count", (t) => {
  const { file, check } = fixture(t);
  const alias = file + ".alias";
  symlinkSync(file, alias);
  check(readTrace(alias));
  const other = file + ".other";
  writeFileSync(other, "first\nsecond\n");
  assert.throws(() => check(readTrace(other)), /coverage mismatch/u);
  const batch = { units: [{ id: "unit", patchFile: path.basename(file), lines: 1 }] };
  assert.throws(
    () => assertPatchReadCoverage(readTrace(file, { limit: 1 }), batch, path.dirname(file)),
    /returned 1 of 2/u
  );
});
