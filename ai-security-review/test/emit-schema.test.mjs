import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/emit-schema.mjs", import.meta.url));

test("schema output survives the action's outer single quotes", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ai-security-review-schema-"));
  const githubOutput = path.join(temporaryRoot, "github-output");
  const schema = {
    type: "object",
    description: "The reviewer's structured result"
  };

  try {
    mkdirSync(path.join(temporaryRoot, "schemas"));
    writeFileSync(path.join(temporaryRoot, "schemas", "fixture.schema.json"), JSON.stringify(schema));
    const result = spawnSync(process.execPath, [script, "fixture"], {
      encoding: "utf8",
      env: { ...process.env, ENGINE_ROOT: temporaryRoot, GITHUB_OUTPUT: githubOutput }
    });
    assert.equal(result.status, 0, result.stderr);
    const encoded = readFileSync(githubOutput, "utf8").trim().slice("schema=".length);
    const decoded = execFileSync("bash", ["-c", `printf '%s' '${encoded}'`], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(decoded), schema);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("candidate schema emission requires a complete plan and the exact requested batch", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-review-batch-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const githubOutput = path.join(root, "github-output");
  const units = ["unit-0014", "unit-0073"].map((id, index) => ({
    id,
    path: `${id}.ts`,
    patchFile: `${id}.patch`,
    baseFile: null,
    baseOmitted: "added-in-pull-request",
    changedLines: index === 0 ? [1] : [60, 61, 90]
  }));
  const batch = { id: "batch-002", units, promptFile: "prompt.md" };
  writeFileSync(path.join(root, "plan.json"), JSON.stringify({ units, batches: [batch] }));
  writeFileSync(path.join(root, "changed-files.json"), "{}\n");
  writeFileSync(path.join(root, "prompt.md"), "Review fixture.\n");
  for (const unit of units) writeFileSync(path.join(root, unit.patchFile), "+fixture\n");
  const environment = {
    ...process.env,
    ENGINE_ROOT: fileURLToPath(new URL("..", import.meta.url)),
    GITHUB_OUTPUT: githubOutput,
    PLAN_DIRECTORY: root,
    BATCH_ID: batch.id
  };
  const result = spawnSync(process.execPath, [script, "candidates"], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  const encoded = readFileSync(githubOutput, "utf8").trim().slice("schema=".length);
  const schema = JSON.parse(execFileSync("bash", ["-c", `printf '%s' '${encoded}'`], { encoding: "utf8" }));
  assert.deepEqual(
    schema.properties.unit_reviews.required,
    units.map((unit) => unit.id)
  );
  for (const unit of units) {
    assert.deepEqual(
      schema.properties.unit_reviews.properties[unit.id].properties.evidence_line.enum,
      unit.changedLines
    );
  }
  for (const overrides of [{ BATCH_ID: "batch-unknown" }, { BATCH_ID: "" }, { PLAN_DIRECTORY: "" }]) {
    const rejected = spawnSync(process.execPath, [script, "candidates"], {
      encoding: "utf8",
      env: { ...environment, ...overrides }
    });
    assert.notEqual(rejected.status, 0);
  }
  rmSync(path.join(root, units[1].patchFile));
  const missing = spawnSync(process.execPath, [script, "candidates"], { encoding: "utf8", env: environment });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /unit-0073\.patch/u);
});
