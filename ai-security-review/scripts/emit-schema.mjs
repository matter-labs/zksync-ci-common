import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const schemaName = process.argv[2];
if (!/^[a-z-]+$/u.test(schemaName ?? "")) throw new Error("schema name is required");
const engineRoot = process.env.ENGINE_ROOT;
const githubOutput = process.env.GITHUB_OUTPUT;
if (!engineRoot || !githubOutput) throw new Error("ENGINE_ROOT and GITHUB_OUTPUT are required");

let schema;
if (schemaName === "candidates") {
  const { readReviewPlan, requireReviewBatch } = await import("./review-plan.mjs");
  const { reviewerOutputSchema } = await import("./reviewer-output.mjs");
  const { PLAN_DIRECTORY: planDirectory, BATCH_ID: batchId } = process.env;
  if (!planDirectory || !batchId) throw new Error("PLAN_DIRECTORY and BATCH_ID are required for candidates");
  schema = reviewerOutputSchema(requireReviewBatch(readReviewPlan(planDirectory), batchId));
} else {
  schema = JSON.parse(readFileSync(path.join(engineRoot, "schemas", `${schemaName}.schema.json`), "utf8"));
}
const shellSafeSchema = JSON.stringify(schema).replaceAll("'", `'"'"'`);
appendFileSync(githubOutput, `schema=${shellSafeSchema}\n`);
