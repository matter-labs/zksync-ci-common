import { withValidationDiagnostics, sessionMetrics } from "./review-diagnostics.mjs";
import { executionWarnings } from "./review-warnings.mjs";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readReviewPlan, requireReviewBatch } from "./review-plan.mjs";
import { partitionCandidatesBySeverity, validateCandidateOutput } from "./review-results.mjs";
import { normalizeReviewerOutput } from "./reviewer-output.mjs";
import { assertPatchReadCoverage, readExecutionOutput, requiredEnvironment } from "./script-utils.mjs";

withValidationDiagnostics("reviewer", () => {
  const planDirectory = path.resolve(requiredEnvironment("PLAN_DIRECTORY"));
  const candidatesDirectory = path.resolve(requiredEnvironment("CANDIDATES_DIRECTORY"));
  const batchId = requiredEnvironment("BATCH_ID");
  const executionFile = path.resolve(requiredEnvironment("EXECUTION_FILE"));
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
  const plan = readReviewPlan(planDirectory);
  const batch = requireReviewBatch(plan, batchId);

  const { messages, structuredOutput } = readExecutionOutput(executionFile, "reviewer");
  assertPatchReadCoverage(messages, batch, planDirectory);
  const parsed = normalizeReviewerOutput(structuredOutput);

  const validatedCandidates = validateCandidateOutput(parsed, batch).map((candidate) => ({
    ...candidate,
    batch_id: batchId
  }));
  const { candidates, prefilteredCandidates } = partitionCandidatesBySeverity(validatedCandidates);
  mkdirSync(candidatesDirectory, { recursive: true });
  const candidateFile = path.join(candidatesDirectory, `candidate-${batchId}.json`);
  writeFileSync(
    candidateFile,
    `${JSON.stringify(
      {
        schema_version: 2,
        batch_id: batchId,
        session: sessionMetrics(messages),
        review_warnings: executionWarnings(messages, [
          path.join(planDirectory, batch.promptFile),
          path.join(planDirectory, "batches", `${batchId}.rendered.md`)
        ]),
        unit_reviews: parsed.unit_reviews.map(({ unit_id, status, evidence_line }) => ({
          unit_id,
          status,
          evidence_line
        })),
        candidates,
        prefiltered_candidates: prefilteredCandidates
      },
      null,
      2
    )}\n`
  );
  appendFileSync(githubOutput, `candidate_file=${candidateFile}\n`);
  appendFileSync(githubOutput, `candidate_count=${candidates.length}\n`);
  console.log(
    `Validated ${candidates.length} publishable candidates and ${prefilteredCandidates.length} low-severity candidates from ${batchId}.`
  );
});
