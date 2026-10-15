import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readReviewPlan, requireReviewBatch } from "../scripts/review-plan.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ai-review-plan-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "plan");
  const files = {
    "changed-files.json": "{}\n",
    "units/unit-0001.patch": "@@ -1 +1 @@\n-before\n+after\n",
    "units/unit-0002.patch": "@@ -0,0 +1 @@\n+registry=https://registry.npmjs.org\n",
    "units/unit-0003.dependency-context.txt": "Untrusted dependency context\n",
    "base/.github/workflows/example.yaml": "name: example\n",
    "base/.npmrc": "",
    "batches/batch-001.prompt.md": "Read {{PLAN_ROOT}}/changed-files.json\n"
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), contents);
  }
  const units = [
    {
      id: "unit-0001",
      path: ".github/workflows/example.yaml",
      patchFile: "units/unit-0001.patch",
      baseFile: "base/.github/workflows/example.yaml"
    },
    { id: "unit-0002", path: ".npmrc", patchFile: "units/unit-0002.patch", baseFile: "base/.npmrc" }
  ].map((unit) => ({ ...unit, baseOmitted: null, changedLines: [1] }));
  units.push({
    ...units[1],
    id: "unit-0003",
    kind: "dependency-context",
    patchFile: "units/unit-0003.dependency-context.txt",
    sourceUnitIds: ["unit-0002"],
    dependencyChangeIds: ["change-1"],
    contentSha256: createHash("sha256").update(files["units/unit-0003.dependency-context.txt"]).digest("hex")
  });
  const plan = {
    units,
    dependencyChanges: [{ id: "change-1", file: ".npmrc", reviewUnitId: "unit-0003" }],
    batches: [{ id: "batch-001", units, maxTurns: 40, promptFile: "batches/batch-001.prompt.md" }]
  };
  const save = () => writeFileSync(path.join(directory, "plan.json"), JSON.stringify(plan));
  save();
  return { root, directory, plan, files, save };
}

test("plan loading and batch lookup fail closed for missing or malformed inputs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ai-review-plan-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => readReviewPlan(directory), /plan\.json/u);
  writeFileSync(path.join(directory, "plan.json"), "not JSON");
  assert.throws(() => readReviewPlan(directory), SyntaxError);
  const batch = { id: "batch-0001", units: [], promptFile: "prompt.md" };
  writeFileSync(path.join(directory, "prompt.md"), "Review this fixture.\n");
  writeFileSync(path.join(directory, "changed-files.json"), "{}\n");
  writeFileSync(path.join(directory, "plan.json"), JSON.stringify({ units: [], batches: [batch] }));
  const plan = readReviewPlan(directory);
  assert.equal(requireReviewBatch(plan, "batch-0001"), plan.batches[0]);
  assert.throws(() => requireReviewBatch(plan, "batch-0002"), /unknown review batch/u);
  assert.throws(() => requireReviewBatch(plan, "../batch-0001"), /unknown review batch/u);
});

test("relocated plans retain hidden snapshots, empty baselines and every advertised file", (t) => {
  const { root, directory, plan } = fixture(t);
  const downloaded = path.join(root, "downloaded");
  cpSync(directory, downloaded, { recursive: true });
  assert.deepEqual(readReviewPlan(downloaded), plan);
  assert.equal(readFileSync(path.join(downloaded, "base/.npmrc"), "utf8"), "");
  for (const file of ["base/.github/workflows/example.yaml", "base/.npmrc"]) {
    const contents = readFileSync(path.join(downloaded, file));
    rmSync(path.join(downloaded, file));
    assert.throws(
      () => readReviewPlan(downloaded),
      (error) => error.message.includes(file)
    );
    writeFileSync(path.join(downloaded, file), contents);
  }
});

test("missing patches, dependency contexts, prompts and manifests fail with the missing path", (t) => {
  const { directory, files } = fixture(t);
  for (const [file, contents] of Object.entries(files)) {
    rmSync(path.join(directory, file));
    assert.throws(
      () => readReviewPlan(directory),
      (error) => error.message.includes(file)
    );
    writeFileSync(path.join(directory, file), contents);
  }
});

test("baseline omissions are explicit and cannot override advertised snapshots", (t) => {
  const { directory, plan, save } = fixture(t);
  const unit = plan.units[0];
  unit.baseFile = null;
  for (const reason of [
    "added-in-pull-request",
    "unsafe-path",
    "missing-at-merge-base",
    "exceeds-file-limit",
    "exceeds-total-limit"
  ]) {
    unit.baseOmitted = reason;
    save();
    assert.doesNotThrow(() => readReviewPlan(directory));
  }
  for (const reason of [null, "", "not-downloaded", undefined]) {
    unit.baseOmitted = reason;
    save();
    assert.throws(() => readReviewPlan(directory), /baseline omission/u);
  }
  unit.baseOmitted = "exceeds-file-limit";
  unit.baseFile = "base/missing.yaml";
  save();
  assert.throws(() => readReviewPlan(directory), /base\/missing.yaml/u);
  delete unit.baseFile;
  save();
  assert.throws(() => readReviewPlan(directory), /baseFile/u);
});

test("batch copies cannot hide or replace a canonical unit's artifact references", (t) => {
  const { directory, plan, save } = fixture(t);
  const batch = plan.batches[0];
  const original = structuredClone(batch.units);
  for (const mutate of [
    (units) => {
      units[0].baseFile = "base/missing.yaml";
    },
    (units) => {
      units[0].patchFile = "units/missing.patch";
    },
    (units) => {
      units[0].baseFile = "base/.npmrc";
    },
    (units) => {
      units.shift();
    },
    (units) => {
      units.push(structuredClone(units[0]));
    }
  ]) {
    batch.units = structuredClone(original);
    mutate(batch.units);
    save();
    assert.throws(() => readReviewPlan(directory), /unit|batch|base\/missing\.yaml/u);
  }
});

test("plan references reject traversal, absolute paths, directories and symlink escapes", (t) => {
  const { root, directory, plan, save } = fixture(t);
  const original = plan.units[0].patchFile;
  const outside = path.join(root, "outside.patch");
  writeFileSync(outside, "Not a plan file\n");
  symlinkSync(outside, path.join(directory, "units", "escape.patch"));
  symlinkSync(root, path.join(directory, "escape-directory"));
  symlinkSync("unit-0001.patch", path.join(directory, "units", "inside.patch"));
  for (const file of [
    "../outside.patch",
    outside,
    "units/../units/unit-0001.patch",
    "units\\unit-0001.patch",
    "units",
    "units/escape.patch",
    "escape-directory/outside.patch",
    "units/invalid\u0000.patch"
  ]) {
    plan.units[0].patchFile = file;
    save();
    assert.throws(() => readReviewPlan(directory), /plan.*file|outside.*plan/u);
  }
  plan.units[0].patchFile = "units/inside.patch";
  save();
  assert.doesNotThrow(() => readReviewPlan(directory));
  plan.units[0].patchFile = original;
  plan.units[0].baseFile = `base/${`${"a".repeat(99)}/`.repeat(4)}${"b".repeat(100)}`;
  mkdirSync(path.dirname(path.join(directory, plan.units[0].baseFile)), { recursive: true });
  writeFileSync(path.join(directory, plan.units[0].baseFile), "");
  save();
  assert.doesNotThrow(() => readReviewPlan(directory));
  rmSync(path.join(directory, "plan.json"));
  symlinkSync(outside, path.join(directory, "plan.json"));
  assert.throws(() => readReviewPlan(directory), /outside the plan directory: plan\.json/u);
});

test("all four consumers reject a missing hidden baseline before proceeding", (t) => {
  const { root, directory } = fixture(t);
  rmSync(path.join(directory, "base/.npmrc"));
  for (const script of ["prepare-batch.mjs", "validate-candidates.mjs", "prepare-verification.mjs", "finalize.mjs"]) {
    const result = spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PLAN_DIRECTORY: directory,
        BATCH_ID: "batch-001",
        SOURCE_DIRECTORY: root,
        CANDIDATES_DIRECTORY: path.join(root, "candidates"),
        VERIFICATION_DIRECTORY: path.join(root, "verification"),
        OUTPUT_DIRECTORY: path.join(root, "output"),
        ENGINE_ROOT: new URL("..", import.meta.url).pathname,
        GITHUB_OUTPUT: path.join(root, "github-output"),
        EXECUTION_FILE: path.join(root, "execution.json")
      }
    });
    assert.equal(result.error, undefined, script);
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /base\/\.npmrc/u, script);
  }
});
