import { ReviewValidationError } from "./review-diagnostics.mjs";
import { createHash } from "node:crypto";
import { assert } from "./assert.mjs";
import { redactSecretMaterial } from "./redaction.mjs";
import { changedLineRanges } from "./review-planning.mjs";
import { dependencyReviewSummary } from "./dependency-context.mjs";
import { CANDIDATE_SCHEMA, MAX_BATCH_UNITS, MAX_VERIFIABLE_CANDIDATES, VERDICT_SCHEMA } from "./review-contract.mjs";

const UNIT_REVIEW_SCHEMA = CANDIDATE_SCHEMA.properties.unit_reviews.items;
const FINDING_SCHEMA = CANDIDATE_SCHEMA.properties.findings.items;
const VERDICT_ITEM_SCHEMA = VERDICT_SCHEMA.properties.verdicts.items;
const MAX_BATCH_FINDINGS = CANDIDATE_SCHEMA.properties.findings.maxItems;
const FINGERPRINT_LENGTH = VERDICT_ITEM_SCHEMA.properties.fingerprint.maxLength;
const FINGERPRINT_PATTERN = new RegExp(VERDICT_ITEM_SCHEMA.properties.fingerprint.pattern, "u");

const MAX_RECORDED_FILTERED_CANDIDATES = 200;

function assertObjectFields(value, schema, name) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  const unknownFields = Object.keys(value).filter((key) => !Object.hasOwn(schema.properties, key));
  assert(unknownFields.length === 0, `${name} contains unknown fields`);
  for (const field of schema.required) {
    assert(Object.hasOwn(value, field), `${name} is missing ${field}`);
  }
}

function requireIdentifier(value, name, { minLength: minimum, maxLength: maximum }) {
  assert(typeof value === "string", `${name} must be a string`);
  assert(value.length >= minimum && value.length <= maximum, `${name} must contain ${minimum}-${maximum} characters`);
  return value;
}

function requireText(value, name, limits) {
  assert(typeof value === "string", `${name} must be a string`);
  return requireIdentifier(redactSecretMaterial(value).trim(), name, limits);
}

function assertChangedLine(line, unit, field) {
  if (Number.isInteger(line) && unit.changedLines.includes(line)) return;
  const location = JSON.stringify(redactSecretMaterial(unit.path));
  const received = Number.isInteger(line) ? line : "non-integer";
  throw new ReviewValidationError(
    `${field} is not changed by the pull request: unit ${unit.id}, file ${location}, received ${received}; ` +
      `allowed ranges ${JSON.stringify(changedLineRanges(unit.changedLines))}`,
    {
      code: "invalid-citation",
      unit_id: unit.id,
      path: redactSecretMaterial(unit.path),
      received,
      allowed_ranges: changedLineRanges(unit.changedLines)
    }
  );
}

export function compactFilteredCandidate(candidate, filterReason = candidate.filter_reason, verification = null) {
  return {
    fingerprint: candidate.fingerprint,
    unit_id: candidate.unit_id,
    file: candidate.file,
    line: candidate.line,
    severity: candidate.severity,
    confidence: candidate.confidence,
    title: candidate.title,
    filter_reason: filterReason,
    verification: verification
      ? {
          verdict: verification.verdict,
          confidence: verification.confidence
        }
      : null
  };
}

export function validateCandidateOutput(value, batch) {
  assertObjectFields(value, CANDIDATE_SCHEMA, "candidate output");
  assert(
    Array.isArray(value.unit_reviews) && value.unit_reviews.length <= MAX_BATCH_UNITS,
    `unit_reviews must contain at most ${MAX_BATCH_UNITS} entries`
  );
  assert(
    Array.isArray(value.findings) && value.findings.length <= MAX_BATCH_FINDINGS,
    `findings must contain at most ${MAX_BATCH_FINDINGS} entries`
  );

  const expectedUnits = batch.units.map((unit) => unit.id).sort();
  const units = new Map(batch.units.map((unit) => [unit.id, unit]));
  const unitReviews = value.unit_reviews.map((review, index) => {
    assertObjectFields(review, UNIT_REVIEW_SCHEMA, `unit_reviews[${index}]`);
    const unitId = requireIdentifier(
      review.unit_id,
      `unit_reviews[${index}].unit_id`,
      UNIT_REVIEW_SCHEMA.properties.unit_id
    );
    const unit = units.get(unitId);
    assert(unit, `unit_reviews[${index}] references unknown unit`);
    assert(
      UNIT_REVIEW_SCHEMA.properties.status.enum.includes(review.status),
      `unit_reviews[${index}] has invalid status`
    );
    assertChangedLine(review.evidence_line, unit, `unit_reviews[${index}].evidence_line`);
    return {
      unit_id: unitId,
      status: review.status,
      summary: requireText(review.summary, `unit_reviews[${index}].summary`, UNIT_REVIEW_SCHEMA.properties.summary),
      evidence_line: review.evidence_line
    };
  });
  const actualUnits = [...new Set(unitReviews.map((review) => review.unit_id))].sort();
  assert(actualUnits.length === unitReviews.length, "unit_reviews must contain each unit exactly once");
  assert(
    JSON.stringify(actualUnits) === JSON.stringify(expectedUnits),
    `review coverage mismatch: expected ${expectedUnits.join(", ")}; received ${actualUnits.join(", ")}`
  );

  const candidates = value.findings.map((finding, index) => {
    assertObjectFields(finding, FINDING_SCHEMA, `findings[${index}]`);
    const findingText = (field) =>
      requireText(finding[field], `findings[${index}].${field}`, FINDING_SCHEMA.properties[field]);
    const unitId = requireIdentifier(finding.unit_id, `findings[${index}].unit_id`, FINDING_SCHEMA.properties.unit_id);
    const unit = units.get(unitId);
    assert(unit, `findings[${index}] references unknown unit`);
    const file = requireIdentifier(finding.file, `findings[${index}].file`, FINDING_SCHEMA.properties.file);
    assert(file === unit.path, `findings[${index}] file does not match ${unitId}`);
    assert(Number.isInteger(finding.line) && finding.line >= 1, `findings[${index}].line must be positive`);
    assertChangedLine(finding.line, unit, `findings[${index}].line`);
    assert(
      FINDING_SCHEMA.properties.severity.enum.includes(finding.severity),
      `findings[${index}] has invalid severity`
    );
    assert(
      FINDING_SCHEMA.properties.confidence.enum.includes(finding.confidence),
      `findings[${index}] has invalid confidence`
    );

    const normalized = {
      unit_id: unitId,
      file,
      line: finding.line,
      severity: finding.severity,
      confidence: finding.confidence,
      title: findingText("title"),
      evidence: findingText("evidence"),
      description: findingText("description"),
      attack_scenario: findingText("attack_scenario"),
      impact: findingText("impact"),
      remediation: findingText("remediation")
    };
    const key = `${normalized.file}\n${normalized.line}\n${normalized.title.toLowerCase().replace(/\s+/gu, " ")}`;
    return { ...normalized, fingerprint: createHash("sha256").update(key).digest("hex").slice(0, FINGERPRINT_LENGTH) };
  });
  for (const review of unitReviews) {
    const hasFinding = candidates.some((candidate) => candidate.unit_id === review.unit_id);
    if (hasFinding !== (review.status === "FINDING")) {
      throw new ReviewValidationError(`unit review ${review.unit_id} status does not match its findings`, {
        code: "inconsistent-disposition",
        unit_id: review.unit_id,
        status: review.status,
        has_findings: hasFinding
      });
    }
  }
  return candidates;
}

export function mergeCandidateLists(candidateLists) {
  const candidates = new Map();
  let duplicates = 0;
  for (const candidate of candidateLists.flat()) {
    if (candidates.has(candidate.fingerprint)) {
      duplicates += 1;
    } else {
      candidates.set(candidate.fingerprint, candidate);
    }
  }
  return { candidates: [...candidates.values()], duplicates };
}

export function partitionCandidatesBySeverity(values) {
  const candidates = [];
  const prefilteredCandidates = [];
  for (const candidate of values) {
    assert(
      FINDING_SCHEMA.properties.severity.enum.includes(candidate.severity),
      `candidate ${candidate.fingerprint} has invalid severity`
    );
    if (candidate.severity === "LOW") {
      prefilteredCandidates.push(compactFilteredCandidate(candidate, "low-severity"));
    } else {
      candidates.push(candidate);
    }
  }
  return { candidates, prefilteredCandidates };
}

export function prepareVerificationCandidates(merged, recordedPrefiltered = []) {
  const partitioned = partitionCandidatesBySeverity(merged.candidates);
  const candidates = partitioned.candidates;
  assert(
    recordedPrefiltered.every((candidate) => candidate.severity === "LOW"),
    "recorded prefiltered candidates must have LOW severity"
  );
  const prefilteredCandidates = [
    ...recordedPrefiltered.map((candidate) => compactFilteredCandidate(candidate, "low-severity")),
    ...partitioned.prefilteredCandidates
  ];
  assert(
    candidates.length <= MAX_VERIFIABLE_CANDIDATES,
    `more than ${MAX_VERIFIABLE_CANDIDATES} publishable candidates require verification; split the pull request into smaller changes`
  );
  const omittedPrefilteredCandidates = Math.max(0, prefilteredCandidates.length - MAX_RECORDED_FILTERED_CANDIDATES);
  return {
    candidates,
    prefilteredCandidates: prefilteredCandidates.slice(0, MAX_RECORDED_FILTERED_CANDIDATES),
    omittedPrefilteredCandidates,
    duplicates: merged.duplicates
  };
}

export function validateVerdictOutput(value, candidates) {
  assertObjectFields(value, VERDICT_SCHEMA, "verdict output");
  assert(
    Array.isArray(value.verdicts) && value.verdicts.length <= MAX_VERIFIABLE_CANDIDATES,
    `verdicts must contain at most ${MAX_VERIFIABLE_CANDIDATES} entries`
  );
  const expected = new Set(candidates.map((candidate) => candidate.fingerprint));
  const verdicts = new Map();

  for (const [index, verdict] of value.verdicts.entries()) {
    assertObjectFields(verdict, VERDICT_ITEM_SCHEMA, `verdicts[${index}]`);
    const fingerprint = requireIdentifier(
      verdict.fingerprint,
      `verdicts[${index}].fingerprint`,
      VERDICT_ITEM_SCHEMA.properties.fingerprint
    );
    assert(FINGERPRINT_PATTERN.test(fingerprint), `verdicts[${index}] has invalid fingerprint`);
    assert(expected.has(fingerprint), `verdicts[${index}] references unknown candidate`);
    assert(!verdicts.has(fingerprint), `verdicts contains duplicate fingerprint: ${fingerprint}`);
    assert(
      VERDICT_ITEM_SCHEMA.properties.verdict.enum.includes(verdict.verdict),
      `verdicts[${index}] has invalid verdict`
    );
    assert(
      VERDICT_ITEM_SCHEMA.properties.confidence.enum.includes(verdict.confidence),
      `verdicts[${index}] has invalid confidence`
    );
    verdicts.set(fingerprint, {
      fingerprint,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reason: requireText(verdict.reason, `verdicts[${index}].reason`, VERDICT_ITEM_SCHEMA.properties.reason)
    });
  }

  assert(verdicts.size === expected.size, "verifier must return exactly one verdict for every candidate");
  return verdicts;
}

export function buildFinalResult(plan, merged, verdicts) {
  const findings = [];
  const filtered = (merged.prefilteredCandidates ?? []).map((candidate) => compactFilteredCandidate(candidate));
  for (const candidate of merged.candidates) {
    assert(
      candidate.severity !== "LOW",
      `candidate ${candidate.fingerprint} reached finalization without passing the verification prefilter`
    );
    const verdict = verdicts.get(candidate.fingerprint);
    assert(verdict, `missing verification verdict: ${candidate.fingerprint}`);

    let filterReason = null;
    if (verdict.verdict !== "CONFIRMED") filterReason = "rejected-by-verifier";
    else if (verdict.confidence !== "HIGH") filterReason = "low-verifier-confidence";

    if (filterReason) {
      filtered.push(compactFilteredCandidate(candidate, filterReason, verdict));
    } else {
      findings.push({ ...candidate, verification: verdict });
    }
  }

  return {
    schema_version: 1,
    status: "complete",
    repository: plan.repository,
    base_sha: plan.baseSha,
    head_sha: plan.headSha,
    reviewed_units: plan.units.map((unit) => unit.id),
    eligible_files: plan.eligibleFiles,
    skipped_files: plan.skippedFiles,
    lockfile_source_changes: plan.lockfileSourceChanges ?? [],
    dependency_changes: plan.dependencyChanges ?? [],
    dependency_review: dependencyReviewSummary(plan.dependencyChanges),
    submodule_changes: plan.submoduleChanges ?? [],
    review_warnings: merged.reviewWarnings ?? [],
    review_batches: plan.batches?.length ?? 0,
    verifier_ran: merged.candidates.length > 0,
    reviewer_sessions: merged.reviewerSessions ?? [],
    findings,
    filtered_candidates: filtered,
    omitted_prefiltered_candidates: merged.omittedPrefilteredCandidates ?? 0,
    duplicate_candidates: merged.duplicates
  };
}
