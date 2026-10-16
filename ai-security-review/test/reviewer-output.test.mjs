import assert from "node:assert/strict";
import test from "node:test";
import { CANDIDATE_SCHEMA, MAX_BATCH_UNITS, VERDICT_SCHEMA } from "../scripts/review-contract.mjs";
import { validateCandidateOutput } from "../scripts/review-results.mjs";
import {
  MAX_REVIEWER_SCHEMA_BYTES,
  normalizeReviewerOutput,
  reviewerOutputSchema,
  splitReviewerBatch
} from "../scripts/reviewer-output.mjs";

const batch = {
  units: [
    { id: "unit-0014", path: "generated.json", changedLines: [1] },
    { id: "unit-0073", path: "auth.ts", changedLines: [60] }
  ]
};
const output = {
  unit_reviews: {
    "unit-0014": { status: "CLEAN", summary: "Reviewed generated metadata.", evidence_line: 1 },
    "unit-0073": { status: "CLEAN", summary: "Traced authentication.", evidence_line: 60 }
  },
  findings: []
};

test("reviewer and verifier tool schemas avoid API-rejected root combinators", () => {
  for (const [name, schema] of [
    ["reviewer", reviewerOutputSchema(batch)],
    ["verifier", VERDICT_SCHEMA]
  ]) {
    for (const keyword of ["oneOf", "allOf", "anyOf"]) {
      assert.equal(Object.hasOwn(schema, keyword), false, `${name} schema must not contain root ${keyword}`);
    }
  }
});

test("deterministic validation rejects dispositions inconsistent with findings", () => {
  const inconsistent = structuredClone(output);
  inconsistent.unit_reviews["unit-0073"].status = "FINDING";
  assert.throws(
    () => validateCandidateOutput(normalizeReviewerOutput(inconsistent), batch),
    (error) => error.diagnostics?.code === "inconsistent-disposition"
  );
});

test("reviewer schemas require every assigned ID, including gaps, without changing the canonical contract", () => {
  const original = structuredClone(CANDIDATE_SCHEMA);
  const schema = reviewerOutputSchema(batch);
  assert.deepEqual(schema.properties.unit_reviews.required, ["unit-0014", "unit-0073"]);
  assert.deepEqual(Object.keys(schema.properties.unit_reviews.properties), ["unit-0014", "unit-0073"]);
  assert.equal(schema.properties.unit_reviews.additionalProperties, false);
  assert.deepEqual(schema.properties.findings.items.properties.unit_id.enum, ["unit-0014", "unit-0073"]);
  for (const unit of batch.units) {
    const entry = schema.properties.unit_reviews.properties[unit.id];
    assert.deepEqual(entry.required, ["status", "summary", "evidence_line"]);
    assert.equal(entry.additionalProperties, false);
    assert.deepEqual(entry.properties.evidence_line, { type: "integer", enum: unit.changedLines });
    for (const field of ["status", "summary"]) {
      assert.equal(entry.properties[field].$ref, `#/definitions/${field}`);
      assert.deepEqual(schema.definitions[field], original.properties.unit_reviews.items.properties[field]);
    }
  }
  assert.deepEqual(CANDIDATE_SCHEMA, original);
  const maximum = {
    units: Array.from({ length: MAX_BATCH_UNITS }, (_, index) => ({
      id: `unit-${index}`,
      path: "fixture.ts",
      changedLines: [1]
    }))
  };
  assert.ok(
    splitReviewerBatch(maximum.units).every(
      (units) => Buffer.byteLength(JSON.stringify(reviewerOutputSchema({ units }))) <= MAX_REVIEWER_SCHEMA_BYTES
    )
  );
  assert.throws(() => reviewerOutputSchema({ units: [] }), /batch size/u);
  assert.throws(() => reviewerOutputSchema({ units: [...maximum.units, { id: "extra" }] }), /batch size/u);
  assert.throws(() => reviewerOutputSchema({ units: [batch.units[0], batch.units[0]] }), /duplicate/u);
});

test("evidence enums preserve sparse source coordinates and isolate units for the same file", () => {
  const units = [
    { id: "unit-0001", path: "auth.ts", changedLines: [60, 61, 90] },
    { id: "unit-0002", path: "auth.ts", changedLines: [100, 101] }
  ];
  const original = structuredClone(units);
  const schema = reviewerOutputSchema({ units });
  for (const unit of units) {
    const evidence = schema.properties.unit_reviews.properties[unit.id].properties.evidence_line;
    assert.equal(evidence.type, "integer");
    assert.deepEqual(evidence.enum, unit.changedLines);
    assert.notEqual(evidence.enum, unit.changedLines);
    for (const invalid of [1, 2, 62, 99, 102]) assert.ok(!evidence.enum.includes(invalid));
  }
  assert.deepEqual(units, original);
});

test("schema generation rejects missing, unordered or invalid evidence coordinates", () => {
  for (const changedLines of [undefined, [], [1, 1], [2, 1], [0], [-1], [1.5], ["1"], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(
      () => reviewerOutputSchema({ units: [{ id: "unit-0001", changedLines }] }),
      /unit-0001 requires sorted, unique, positive changed lines/u
    );
  }
});

test("oversized schemas split batches without omitting units or their allowed evidence lines", () => {
  const units = Array.from({ length: 30 }, (_, index) => ({
    id: `unit-${String(index + 1).padStart(4, "0")}`,
    path: "fixture.ts",
    changedLines: Array.from({ length: 1500 }, (_, line) => index * 1500 + line + 1)
  }));
  const original = structuredClone(units);
  assert.throws(() => reviewerOutputSchema({ units }), /schema exceeds the byte limit/u);
  const batches = splitReviewerBatch(units);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), original);
  assert.deepEqual(units, original);
  for (const units of batches) {
    const schema = reviewerOutputSchema({ units });
    assert.ok(Buffer.byteLength(JSON.stringify(schema)) <= MAX_REVIEWER_SCHEMA_BYTES);
    for (const unit of units) {
      assert.deepEqual(
        schema.properties.unit_reviews.properties[unit.id].properties.evidence_line.enum,
        unit.changedLines
      );
    }
  }
  assert.deepEqual(splitReviewerBatch(batch.units), [batch.units]);
});

test("one oversized unit fails preparation instead of truncating its evidence lines", () => {
  const unit = {
    id: "unit-0001",
    kind: "dependency-context",
    path: "fixture.ts",
    changedLines: Array.from({ length: 30000 }, (_, index) => index + 1)
  };
  assert.throws(
    () => splitReviewerBatch([unit]),
    /unit-0001 exceeds the reviewer schema byte limit; split the pull request/u
  );
});

test("schema splitting also bounds shell quoting expansion from source paths", () => {
  const units = Array.from({ length: 200 }, (_, index) => ({
    id: `unit-${index}`,
    path: "'".repeat(450),
    changedLines: [1]
  }));
  const batches = splitReviewerBatch(units);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), units);
  for (const units of batches) {
    const encoded = JSON.stringify(reviewerOutputSchema({ units })).replaceAll("'", `'"'"'`);
    assert.ok(Buffer.byteLength(encoded) <= MAX_REVIEWER_SCHEMA_BYTES);
  }
});

test("normalization preserves complete results and cannot fill omitted dispositions or repair bad evidence", () => {
  const original = structuredClone(output);
  const canonical = normalizeReviewerOutput(output);
  assert.deepEqual(validateCandidateOutput(canonical, batch), []);
  assert.deepEqual(
    canonical.unit_reviews.map((review) => review.unit_id),
    ["unit-0014", "unit-0073"]
  );
  assert.deepEqual(output, original);
  const incomplete = structuredClone(output);
  delete incomplete.unit_reviews["unit-0073"];
  assert.throws(() => validateCandidateOutput(normalizeReviewerOutput(incomplete), batch), /coverage mismatch/u);
  const invalid = structuredClone(output);
  invalid.unit_reviews["unit-0073"].evidence_line = 1;
  assert.throws(
    () => validateCandidateOutput(normalizeReviewerOutput(invalid), batch),
    /evidence_line is not changed/u
  );
  const unknown = structuredClone(output);
  unknown.unit_reviews["unit-unknown"] = unknown.unit_reviews["unit-0073"];
  assert.throws(() => validateCandidateOutput(normalizeReviewerOutput(unknown), batch), /unknown unit/u);
});

test("normalization rejects malformed maps and retains fields for independent validation", () => {
  for (const value of [null, {}, { unit_reviews: [] }, { unit_reviews: { "unit-0014": null } }]) {
    assert.throws(() => normalizeReviewerOutput(value), /must be an object/u);
  }
  assert.throws(
    () => normalizeReviewerOutput({ unit_reviews: { "unit-0014": { unit_id: "unit-0073" } } }),
    /object key/u
  );
  assert.throws(
    () =>
      normalizeReviewerOutput({
        unit_reviews: Object.fromEntries(Array.from({ length: MAX_BATCH_UNITS + 1 }, (_, id) => [id, {}]))
      }),
    /at most/u
  );
  assert.throws(
    () => validateCandidateOutput(normalizeReviewerOutput({ ...output, extra: true }), batch),
    /unknown fields/u
  );
  const extra = structuredClone(output);
  extra.unit_reviews["unit-0014"].extra = true;
  assert.throws(() => validateCandidateOutput(normalizeReviewerOutput(extra), batch), /unknown fields/u);
});
