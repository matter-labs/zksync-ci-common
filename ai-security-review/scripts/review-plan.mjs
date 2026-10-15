import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assert } from "./assert.mjs";
import { assertDependencyContextPlan } from "./dependency-context.mjs";
import { isSafeRepositoryPath } from "./repository-paths.mjs";

const BASE_OMISSIONS = new Set([
  "added-in-pull-request",
  "submodule-pointer",
  "unsafe-path",
  "missing-at-merge-base",
  "exceeds-file-limit",
  "exceeds-total-limit"
]);

function requirePlanFile(root, file) {
  // Baseline paths add a generated prefix to an already bounded repository path.
  const repositoryPath = typeof file === "string" && file.startsWith("base/") ? file.slice(5) : file;
  assert(isSafeRepositoryPath(repositoryPath), `review plan has an unsafe file reference: ${JSON.stringify(file)}`);
  let resolved;
  try {
    resolved = realpathSync(path.join(root, file));
  } catch (cause) {
    throw new Error(`review plan file is missing or inaccessible: ${file}`, { cause });
  }
  const relative = path.relative(root, resolved);
  assert(
    relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `review plan file resolves outside the plan directory: ${file}`
  );
  assert(statSync(resolved).isFile(), `review plan reference is not a regular file: ${file}`);
  try {
    accessSync(resolved, constants.R_OK);
  } catch (cause) {
    throw new Error(`review plan file is unreadable: ${file}`, { cause });
  }
}

function assertPlanFiles(plan, directory) {
  const root = realpathSync(directory);
  const checked = new Set();
  const checkFile = (file) => {
    if (checked.has(file)) return;
    requirePlanFile(root, file);
    checked.add(file);
  };
  const checkUnit = (unit) => {
    checkFile(unit.patchFile);
    if (unit.baseFile === null) {
      assert(BASE_OMISSIONS.has(unit.baseOmitted), `review unit ${unit.id} has no valid baseline omission reason`);
    } else {
      assert(typeof unit.baseFile === "string", `review unit ${unit.id} has no baseFile or explicit omission`);
      checkFile(unit.baseFile);
      assert(unit.baseOmitted === null, `review unit ${unit.id} both advertises and omits baseline ${unit.baseFile}`);
    }
  };
  checkFile("plan.json");
  checkFile("changed-files.json");
  const units = new Map(plan.units.map((unit) => [unit.id, unit]));
  for (const unit of plan.units) checkUnit(unit);
  const assigned = new Set();
  const batches = new Set();
  for (const batch of plan.batches) {
    assert(!batches.has(batch.id), `duplicate review batch: ${batch.id}`);
    batches.add(batch.id);
    checkFile(batch.promptFile);
    assert(Array.isArray(batch.units), `review batch ${batch.id} has no units`);
    for (const unit of batch.units) {
      checkUnit(unit);
      assert(
        isDeepStrictEqual(unit, units.get(unit.id)),
        `review batch ${batch.id} has a conflicting unit: ${unit.id}`
      );
      assert(!assigned.has(unit.id), `review unit ${unit.id} is assigned to multiple batches`);
      assigned.add(unit.id);
    }
  }
  assert(assigned.size === units.size, "review plan has units missing from batches");
}

export function readReviewPlan(directory) {
  const root = realpathSync(directory);
  requirePlanFile(root, "plan.json");
  const plan = JSON.parse(readFileSync(path.join(root, "plan.json"), "utf8"));
  assert(plan && Array.isArray(plan.units) && Array.isArray(plan.batches), "review plan requires units and batches");
  assertDependencyContextPlan(plan);
  assertPlanFiles(plan, root);
  return plan;
}

export function requireReviewBatch(plan, batchId) {
  const batch = plan.batches.find((entry) => entry.id === batchId);
  if (!batch) throw new Error(`unknown review batch: ${batchId}`);
  return batch;
}
