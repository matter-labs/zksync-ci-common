import { mergeWarnings, planWarnings } from "./review-warnings.mjs";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderPlanPrompt } from "./rendering.mjs";
import { readReviewPlan, requireReviewBatch } from "./review-plan.mjs";
import { verifierTurnBudget } from "./review-planning.mjs";
import { mergeCandidateLists, prepareVerificationCandidates } from "./review-results.mjs";
import { requiredEnvironment } from "./script-utils.mjs";

function candidateFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return candidateFiles(entryPath);
    return /^candidate-batch-\d+\.json$/u.test(entry.name) ? [entryPath] : [];
  });
}

const planDirectory = path.resolve(requiredEnvironment("PLAN_DIRECTORY"));
const candidatesDirectory = path.resolve(requiredEnvironment("CANDIDATES_DIRECTORY"));
const outputDirectory = path.resolve(requiredEnvironment("OUTPUT_DIRECTORY"));
const engineRoot = path.resolve(requiredEnvironment("ENGINE_ROOT"));
const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
const sourceDirectory = requiredEnvironment("SOURCE_DIRECTORY");
const plan = readReviewPlan(planDirectory);
const files = candidateFiles(candidatesDirectory);
const candidateDocuments = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
const expectedBatchIds = plan.batches.map((batch) => batch.id).sort();
const actualBatchIds = candidateDocuments.map((document) => document.batch_id).sort();

if (JSON.stringify(actualBatchIds) !== JSON.stringify(expectedBatchIds)) {
  throw new Error(
    `candidate artifact coverage mismatch: expected ${expectedBatchIds.join(", ")}; received ${actualBatchIds.join(", ")}`
  );
}

const merged = prepareVerificationCandidates(
  mergeCandidateLists(candidateDocuments.map((document) => document.candidates)),
  candidateDocuments.flatMap((document) => document.prefiltered_candidates ?? [])
);
merged.reviewWarnings = mergeWarnings(
  planWarnings(plan, planDirectory),
  candidateDocuments.flatMap((document) => document.review_warnings ?? [])
);
merged.reviewerSessions = candidateDocuments.map((document) => ({
  batch_id: document.batch_id,
  ...(document.session ?? {})
}));
mkdirSync(outputDirectory, { recursive: true });
const candidatesFile = path.join(outputDirectory, "candidates.json");
writeFileSync(candidatesFile, `${JSON.stringify(merged, null, 2)}\n`);
const maxTurns = verifierTurnBudget(merged.candidates.length);

if (merged.candidates.length > 0) {
  const batchIds = [...new Set(merged.candidates.map((candidate) => candidate.batch_id))].sort();
  const renderedBatchesDirectory = path.join(outputDirectory, "batches");
  mkdirSync(renderedBatchesDirectory, { recursive: true });
  const renderedPrompts = batchIds.map((batchId) => {
    const batch = requireReviewBatch(plan, batchId);
    const template = readFileSync(path.join(planDirectory, batch.promptFile), "utf8");
    const renderedFile = path.join(renderedBatchesDirectory, `${batchId}.prompt.md`);
    writeFileSync(renderedFile, renderPlanPrompt(template, planDirectory, sourceDirectory));
    return renderedFile;
  });
  const verifierTask = readFileSync(path.join(engineRoot, "prompts", "verifier.md"), "utf8").trim();
  const prompt = [
    verifierTask,
    "# Budget",
    `This session allows at most ${maxTurns} turns for ${merged.candidates.length} candidates. Plan your reads so the structured output is returned before the limit.`,
    "# Inputs",
    `Source checkout (untrusted): ${JSON.stringify(sourceDirectory)}. Resolve repository paths against this directory, not the session working directory.`,
    `Candidate findings: ${candidatesFile}`,
    `Pull request manifest: ${path.join(planDirectory, "changed-files.json")}`,
    "Read the following batch prompts for the profiles, trusted context, unit manifest, patch locations, and base snapshots:",
    ...renderedPrompts.map((promptPath) => `- ${promptPath}`)
  ].join("\n\n");
  writeFileSync(path.join(outputDirectory, "verifier.prompt.md"), `${prompt}\n`);
}

appendFileSync(githubOutput, `has_candidates=${merged.candidates.length > 0}\n`);
appendFileSync(githubOutput, `candidate_count=${merged.candidates.length}\n`);
appendFileSync(githubOutput, `candidates_file=${candidatesFile}\n`);
appendFileSync(githubOutput, `max_turns=${maxTurns}\n`);
console.log(`Prepared verification for ${merged.candidates.length} unique candidates.`);
