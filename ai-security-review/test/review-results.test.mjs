import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { redactSecretMaterial } from "../scripts/redaction.mjs";
import {
  validateCandidateOutput,
  mergeCandidateLists,
  partitionCandidatesBySeverity,
  prepareVerificationCandidates,
  validateVerdictOutput,
  buildFinalResult
} from "../scripts/review-results.mjs";
import { batch, candidateOutput } from "./candidate-fixture.mjs";

test("candidate validation requires complete coverage and changed-line evidence", () => {
  const candidates = validateCandidateOutput(candidateOutput(), batch);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].fingerprint, /^[a-f0-9]{16}$/u);
  assert.throws(() => validateCandidateOutput(candidateOutput({ line: 13 }), batch), /not changed/u);
  const [redacted] = validateCandidateOutput(
    candidateOutput({ evidence: `Leaked ${"sk-ant-"}${"a".repeat(24)}` }),
    batch
  );
  assert.equal(redacted.evidence, "Leaked [REDACTED API KEY]");
  const [longSecretRedacted] = validateCandidateOutput(
    candidateOutput({
      evidence: `Leaked -----BEGIN PRIVATE KEY-----\n${"a".repeat(1500)}\n-----END PRIVATE KEY-----`
    }),
    batch
  );
  assert.equal(longSecretRedacted.evidence, "Leaked [REDACTED PRIVATE KEY]");
  assert.equal(
    redactSecretMaterial(`AIza${"a".repeat(35)} xoxc-${"a".repeat(20)}`),
    "[REDACTED GOOGLE API KEY] [REDACTED SLACK TOKEN]"
  );
  const opaqueDigest = Buffer.from("unlabelled-material-cannot-be-classified-by-length").toString("base64");
  assert.equal(redactSecretMaterial(opaqueDigest), opaqueDigest);
  assert.throws(() => redactSecretMaterial("x".repeat(8_001)), /exceeds the safe limit/u);
  assert.throws(() => validateCandidateOutput({ ...candidateOutput(), unit_reviews: [] }, batch), /coverage mismatch/u);
  assert.throws(
    () =>
      validateCandidateOutput(
        {
          ...candidateOutput(),
          unit_reviews: [{ ...candidateOutput().unit_reviews[0], status: "CLEAN" }]
        },
        batch
      ),
    /status does not match/u
  );
});

test("invalid citations identify the unit, file, rejected line and allowed source ranges", () => {
  const sparseBatch = { ...batch, units: [{ ...batch.units[0], changedLines: [12, 13, 20] }] };
  const invalidReview = candidateOutput();
  invalidReview.unit_reviews[0].evidence_line = 14;
  for (const [output, field] of [
    [invalidReview, "unit_reviews[0].evidence_line"],
    [candidateOutput({ line: 14 }), "findings[0].line"]
  ]) {
    assert.throws(() => validateCandidateOutput(output, sparseBatch), {
      message:
        `${field} is not changed by the pull request: unit unit-0001, file "src/auth.ts", received 14; ` +
        "allowed ranges [[12,13],[20,20]]"
    });
  }
});

test("citation diagnostics redact paths and never echo non-integer model values", () => {
  const secret = `ghp_${"s".repeat(24)}`;
  const pathBatch = { ...batch, units: [{ ...batch.units[0], path: `src/${secret}.ts` }] };
  const output = candidateOutput();
  output.unit_reviews[0].evidence_line = secret;
  assert.throws(
    () => validateCandidateOutput(output, pathBatch),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      assert.match(error.message, /received non-integer; allowed ranges \[\[12,12\]\]/u);
      assert.match(error.message, /REDACTED/u);
      return true;
    }
  );
});

test("canonical finding paths are validated without trimming or redaction", () => {
  for (const file of [`dist/${"ab".repeat(32)}.mjs`, " src/auth.ts ", `src/ghp_${"a".repeat(24)}.ts`]) {
    const pathBatch = { ...batch, units: [{ ...batch.units[0], path: file }] };
    const [candidate] = validateCandidateOutput(candidateOutput({ file }), pathBatch);
    assert.equal(candidate.file, file);
    const fingerprint = createHash("sha256")
      .update(`${file}\n12\n${candidate.title.toLowerCase()}`)
      .digest("hex")
      .slice(0, 16);
    assert.equal(candidate.fingerprint, fingerprint);
    assert.throws(
      () => validateCandidateOutput(candidateOutput({ file: `${file}x` }), pathBatch),
      /file does not match/u
    );
  }
  const file = `src/ghp_${"a".repeat(24)}.ts`;
  const otherFile = `src/ghp_${"b".repeat(24)}.ts`;
  assert.equal(redactSecretMaterial(file), redactSecretMaterial(otherFile));
  assert.throws(
    () =>
      validateCandidateOutput(candidateOutput({ file: otherFile }), {
        ...batch,
        units: [{ ...batch.units[0], path: file }]
      }),
    /file does not match/u
  );
});

test("validation errors never echo rejected model identifiers or object keys", () => {
  const secret = `ghp_${"s".repeat(24)}`;
  for (const output of [
    { ...candidateOutput(), [secret]: true },
    candidateOutput({ [secret]: true }),
    candidateOutput({ unit_id: secret }),
    { ...candidateOutput(), unit_reviews: [{ ...candidateOutput().unit_reviews[0], unit_id: secret }] }
  ]) {
    assert.throws(
      () => validateCandidateOutput(output, batch),
      (error) => !error.message.includes(secret)
    );
  }
  assert.throws(
    () => validateCandidateOutput(candidateOutput({ description: " ".repeat(8_001) }), batch),
    /safe limit/u
  );
});

test("all finding narrative fields and verifier reasons pass through the redaction floor", () => {
  const secret = "postgresql://fixture:fake-pass@db.example/app";
  const fields = ["title", "evidence", "description", "attack_scenario", "impact", "remediation"];
  const [candidate] = validateCandidateOutput(
    candidateOutput(Object.fromEntries(fields.map((field) => [field, secret]))),
    batch
  );
  for (const field of fields) assert.doesNotMatch(candidate[field], /fake-pass/u);
  const verdict = { fingerprint: candidate.fingerprint, verdict: "CONFIRMED", confidence: "HIGH", reason: secret };
  const verdicts = validateVerdictOutput({ verdicts: [verdict] }, [candidate]);
  assert.doesNotMatch(verdicts.get(candidate.fingerprint).reason, /fake-pass/u);
  assert.throws(
    () => validateVerdictOutput({ verdicts: [{ ...verdict, fingerprint: ` ${candidate.fingerprint}` }] }, [candidate]),
    /characters/u
  );
});

test("verification excludes candidates that cannot be published", () => {
  const high = validateCandidateOutput(candidateOutput(), batch)[0];
  const low = validateCandidateOutput(candidateOutput({ severity: "LOW", title: "Low severity issue" }), batch)[0];
  const uncertain = validateCandidateOutput(
    candidateOutput({ confidence: "MEDIUM", title: "Uncertain issue" }),
    batch
  )[0];
  const prepared = prepareVerificationCandidates(mergeCandidateLists([[high, low, uncertain]]));
  assert.deepEqual(
    prepared.candidates.map((candidate) => candidate.fingerprint),
    [high.fingerprint, uncertain.fingerprint]
  );
  assert.deepEqual(
    prepared.prefilteredCandidates.map((candidate) => candidate.filter_reason),
    ["low-severity"]
  );
});

test("only independently confirmed, high-confidence HIGH or MEDIUM findings are published", () => {
  const [candidate] = validateCandidateOutput(candidateOutput(), batch);
  const merged = mergeCandidateLists([[candidate]]);
  const verdicts = validateVerdictOutput(
    {
      verdicts: [
        {
          fingerprint: candidate.fingerprint,
          verdict: "CONFIRMED",
          confidence: "HIGH",
          reason: "No compensating authorization check exists."
        }
      ]
    },
    merged.candidates
  );
  const result = buildFinalResult(
    {
      repository: "matter-labs/example",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      units: batch.units,
      eligibleFiles: ["src/auth.ts"],
      skippedFiles: []
    },
    merged,
    verdicts
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.filtered_candidates.length, 0);
});

test("prefiltered candidates do not count against the verifier cap", () => {
  const lows = Array.from(
    { length: 51 },
    (_, index) => validateCandidateOutput(candidateOutput({ severity: "LOW", title: `Low issue ${index}` }), batch)[0]
  );
  const prepared = prepareVerificationCandidates(mergeCandidateLists([lows]));
  assert.equal(prepared.candidates.length, 0);
  assert.equal(prepared.prefilteredCandidates.length, 51);
  assert.equal(prepared.omittedPrefilteredCandidates, 0);

  const highs = Array.from(
    { length: 51 },
    (_, index) => validateCandidateOutput(candidateOutput({ title: `High issue ${index}` }), batch)[0]
  );
  assert.throws(
    () => prepareVerificationCandidates(mergeCandidateLists([highs])),
    /more than 50 publishable candidates/u
  );
});

test("finalization rejects candidates that bypassed the prefilter", () => {
  const [low] = validateCandidateOutput(candidateOutput({ severity: "LOW" }), batch);
  assert.throws(
    () => buildFinalResult({ units: [] }, { candidates: [low], duplicates: 0 }, new Map()),
    /without passing the verification prefilter/u
  );
  const [high] = validateCandidateOutput(candidateOutput(), batch);
  assert.throws(
    () => buildFinalResult({ units: [] }, { candidates: [high], duplicates: 0 }, new Map()),
    /missing verification verdict/u
  );
});

test("verdicts reject fields outside their output schema", () => {
  const [candidate] = validateCandidateOutput(candidateOutput(), batch);
  const verdict = { fingerprint: candidate.fingerprint, verdict: "CONFIRMED", confidence: "HIGH", reason: "Checked" };
  assert.throws(() => validateVerdictOutput({ verdicts: [verdict], extra: true }, [candidate]), /unknown fields/u);
  assert.throws(
    () => validateVerdictOutput({ verdicts: [{ ...verdict, extra: true }] }, [candidate]),
    /unknown fields/u
  );
});

test("severity partitioning retains uncertain HIGH and MEDIUM candidates and compacts LOW findings", () => {
  const candidates = [
    candidateOutput({ confidence: "LOW" }),
    candidateOutput({ severity: "MEDIUM", confidence: "LOW" }),
    candidateOutput({ severity: "LOW" })
  ].flatMap((output) => validateCandidateOutput(output, batch));
  const partitioned = partitionCandidatesBySeverity(candidates);
  assert.deepEqual(partitioned.candidates, candidates.slice(0, 2));
  assert.equal(partitioned.prefilteredCandidates.length, 1);
  assert.equal(partitioned.prefilteredCandidates[0].filter_reason, "low-severity");
  assert.equal(Object.hasOwn(partitioned.prefilteredCandidates[0], "evidence"), false);
  assert.throws(() => partitionCandidatesBySeverity([{ ...candidates[0], severity: "unknown" }]), /invalid severity/u);
});

test("recorded and newly filtered candidates share one aggregate cap and omission count", () => {
  const [low] = validateCandidateOutput(candidateOutput({ severity: "LOW" }), batch);
  const [high] = validateCandidateOutput(candidateOutput(), batch);
  for (const [recordedCount, newCount] of [
    [199, 0],
    [199, 1],
    [199, 2],
    [210, 220]
  ]) {
    const recorded = Array.from({ length: recordedCount }, (_, index) => ({
      ...low,
      fingerprint: `recorded-${index}`
    }));
    const newLows = Array.from({ length: newCount }, (_, index) => ({ ...low, fingerprint: `new-${index}` }));
    const result = prepareVerificationCandidates({ candidates: [high, ...newLows], duplicates: 3 }, recorded);
    assert.deepEqual(result.candidates, [high]);
    assert.equal(result.prefilteredCandidates.length, Math.min(recordedCount + newCount, 200));
    assert.equal(result.omittedPrefilteredCandidates, Math.max(0, recordedCount + newCount - 200));
    assert.equal(result.duplicates, 3);
    assert.deepEqual(
      result.prefilteredCandidates.map((candidate) => candidate.fingerprint),
      [...recorded, ...newLows].slice(0, 200).map((candidate) => candidate.fingerprint)
    );
    assert.ok(result.prefilteredCandidates.every((candidate) => !Object.hasOwn(candidate, "evidence")));
  }
  assert.throws(
    () => prepareVerificationCandidates({ candidates: [], duplicates: 0 }, [high]),
    /must have LOW severity/u
  );
});
