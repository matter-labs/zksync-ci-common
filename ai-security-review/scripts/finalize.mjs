import { withValidationDiagnostics, sessionMetrics } from "./review-diagnostics.mjs";
import { executionWarnings, mergeWarnings } from "./review-warnings.mjs";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderComment } from "./rendering.mjs";
import { readReviewPlan } from "./review-plan.mjs";
import { buildFinalResult, validateVerdictOutput } from "./review-results.mjs";
import {
  assertPatchReadCoverage,
  booleanEnvironment,
  readExecutionOutput,
  requiredEnvironment
} from "./script-utils.mjs";

withValidationDiagnostics("verifier", () => {
  const planDirectory = path.resolve(requiredEnvironment("PLAN_DIRECTORY"));
  const verificationDirectory = path.resolve(requiredEnvironment("VERIFICATION_DIRECTORY"));
  const outputDirectory = path.resolve(requiredEnvironment("OUTPUT_DIRECTORY"));
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
  const failOnFindings = booleanEnvironment("FAIL_ON_FINDINGS");
  const plan = readReviewPlan(planDirectory);
  const merged = JSON.parse(readFileSync(path.join(verificationDirectory, "candidates.json"), "utf8"));

  let verdicts;
  let verifierSession = null;
  if (merged.candidates.length === 0) {
    verdicts = new Map();
  } else {
    const executionFile = path.resolve(requiredEnvironment("EXECUTION_FILE"));
    const { messages, structuredOutput: parsed } = readExecutionOutput(executionFile, "verifier");
    const candidateUnitIds = new Set(merged.candidates.map((candidate) => candidate.unit_id));
    assertPatchReadCoverage(
      messages,
      { units: plan.units.filter((unit) => candidateUnitIds.has(unit.id)) },
      planDirectory
    );
    verdicts = validateVerdictOutput(parsed, merged.candidates);
    verifierSession = sessionMetrics(messages);
    merged.reviewWarnings = mergeWarnings(
      merged.reviewWarnings ?? [],
      executionWarnings(messages, [
        path.join(verificationDirectory, "verifier.prompt.md"),
        ...plan.batches.map((batch) => path.join(verificationDirectory, "batches", `${batch.id}.prompt.md`)),
        ...plan.batches.map((batch) => path.join(planDirectory, batch.promptFile))
      ])
    );
  }

  const result = buildFinalResult(plan, merged, verdicts);
  result.fail_on_findings = failOnFindings;
  result.verifier_session = verifierSession;
  if (process.env.RUN_URL) result.run_url = process.env.RUN_URL;
  const comment = renderComment(result);
  mkdirSync(outputDirectory, { recursive: true });
  const resultFile = path.join(outputDirectory, "result.json");
  const commentFile = path.join(outputDirectory, "comment.md");
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(commentFile, comment);
  appendFileSync(githubOutput, `result_file=${resultFile}\n`);
  appendFileSync(githubOutput, `comment_file=${commentFile}\n`);
  appendFileSync(githubOutput, `finding_count=${result.findings.length}\n`);
  appendFileSync(githubOutput, `skipped_file_count=${result.skipped_files.length}\n`);
  appendFileSync(githubOutput, `lockfile_source_count=${result.lockfile_source_changes.length}\n`);
  console.log(
    `Completed security review with ${result.findings.length} published findings and ${result.filtered_candidates.length} filtered candidates.`
  );
});
