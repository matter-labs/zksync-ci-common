import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderPlanPrompt } from "./rendering.mjs";
import { readReviewPlan, requireReviewBatch } from "./review-plan.mjs";
import { requiredEnvironment } from "./script-utils.mjs";

const planDirectory = path.resolve(requiredEnvironment("PLAN_DIRECTORY"));
const batchId = requiredEnvironment("BATCH_ID");
const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
const sourceDirectory = requiredEnvironment("SOURCE_DIRECTORY");
const plan = readReviewPlan(planDirectory);
const batch = requireReviewBatch(plan, batchId);
if (!Number.isInteger(batch.maxTurns) || batch.maxTurns <= 0) {
  throw new Error(`batch ${batchId} has no valid turn budget`);
}

const template = readFileSync(path.join(planDirectory, batch.promptFile), "utf8");
const promptFile = path.join(planDirectory, "batches", `${batchId}.rendered.md`);
writeFileSync(promptFile, renderPlanPrompt(template, planDirectory, sourceDirectory));
appendFileSync(githubOutput, `prompt_file=${promptFile}\n`);
appendFileSync(githubOutput, `max_turns=${batch.maxTurns}\n`);
console.log(`Rendered ${batchId} prompt with a budget of ${batch.maxTurns} turns.`);
