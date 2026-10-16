import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { batch, candidateOutput } from "./candidate-fixture.mjs";
import { parse } from "yaml";

function isolatedEngine(t, includeSchemas = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ai-review-modules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL("../scripts", import.meta.url), path.join(root, "scripts"), { recursive: true });
  if (includeSchemas) {
    cpSync(new URL("../schemas", import.meta.url), path.join(root, "schemas"), { recursive: true });
  }
  return root;
}

function runModules(root, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
}

test("every credentialed entrypoint's static import graph excludes external packages", (t) => {
  const root = isolatedEngine(t);
  const entrypoints = new Set();
  for (const action of ["review", "verify"]) {
    const definition = parse(readFileSync(new URL(`../actions/${action}/action.yml`, import.meta.url), "utf8"));
    for (const step of definition.runs.steps) {
      for (const match of (step.run ?? "").matchAll(/\$ENGINE_ROOT\/scripts\/([a-z-]+\.mjs)/gu))
        entrypoints.add(match[1]);
    }
  }
  assert.equal(entrypoints.size, 7);
  const source = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { isBuiltin } from "node:module";
    import { SourceTextModule } from "node:vm";
    import path from "node:path";
    const root = path.resolve("scripts");
    const pending = ${JSON.stringify([...entrypoints])}.map(name => path.join(root, name));
    const visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const module = new SourceTextModule(readFileSync(file, "utf8"));
      for (const specifier of module.dependencySpecifiers) {
        if (specifier.startsWith("node:") && isBuiltin(specifier)) continue;
        assert(specifier.startsWith("./") || specifier.startsWith("../"), "external import: " + specifier);
        const target = path.resolve(path.dirname(file), specifier);
        assert(target.startsWith(root + path.sep), "import leaves engine scripts");
        pending.push(target);
      }
    }
  `;
  const run = () =>
    spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "--eval", source], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000
    });
  const clean = run();
  assert.equal(clean.status, 0, `${clean.error ?? ""}\n${clean.stderr}`);
  const renderer = path.join(root, "scripts/rendering.mjs");
  writeFileSync(renderer, `import "yaml";\n${readFileSync(renderer, "utf8")}`);
  const unsafe = run();
  assert.equal(unsafe.status, 1, unsafe.stderr);
  assert.match(unsafe.stderr, /external import: yaml/u);
});

test("globs, paths, redaction, rendering and lockfile policy work without schemas or parser packages", (t) => {
  const root = isolatedEngine(t);
  runModules(
    root,
    `
    import assert from "node:assert/strict";
    import { matchesGlob, validateGlob } from "./scripts/globs.mjs";
    import { isSafeRepositoryPath } from "./scripts/repository-paths.mjs";
    import { redactSecretMaterial } from "./scripts/redaction.mjs";
    import { renderPlanPrompt } from "./scripts/rendering.mjs";
    import { lockfileSourceViolations } from "./scripts/lockfile-policy.mjs";
    import { contentProfileSignals } from "./scripts/content-profile-signals.mjs";
    import { withLockfilePackageIdentity } from "./scripts/lockfile-identities.mjs";

    validateGlob("**/*.ts");
    assert.equal(matchesGlob("**/*.ts", "src/auth.ts"), true);
    assert.equal(isSafeRepositoryPath("../outside"), false);
    assert.equal(redactSecretMaterial("sk-ant-" + "a".repeat(24)), "[REDACTED API KEY]");
    assert.ok(renderPlanPrompt("Read {{PLAN_ROOT}}/patch", "/plan", "/source").endsWith("Read /plan/patch"));
    assert.deepEqual(lockfileSourceViolations([]), []);
    assert.equal(withLockfilePackageIdentity("pnpm-lock.yaml", {}, {
      location: JSON.stringify(["packages", "pkg@1.0.0(peer@2.0.0)", "resolution", "tarball"])
    }).packageName, "pkg");
    assert.equal(contentProfileSignals('import "jose";')[0].id, "jwt-library");
    assert.throws(() => validateGlob("*".repeat(301)), /at most 300 characters/u);
  `
  );
});

test("review output validation and finalization do not load lockfile parsers", (t) => {
  const root = isolatedEngine(t, true);
  runModules(
    root,
    `
    import assert from "node:assert/strict";
    import {
      buildFinalResult, mergeCandidateLists, prepareVerificationCandidates,
      validateCandidateOutput, validateVerdictOutput
    } from "./scripts/review-results.mjs";
    import { renderComment } from "./scripts/rendering.mjs";

    const batch = { units: [] };
    const candidates = validateCandidateOutput({ unit_reviews: [], findings: [] }, batch);
    const merged = prepareVerificationCandidates(mergeCandidateLists([candidates]));
    const verdicts = validateVerdictOutput({ verdicts: [] }, candidates);
    const result = buildFinalResult({ units: [], eligibleFiles: [], skippedFiles: [] }, merged, verdicts);
    assert.equal(result.status, "complete");
    assert.match(renderComment(result), /No reportable security findings/u);
    await assert.rejects(import("./scripts/lockfile-sources.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
  `
  );
});

test("batch planning and output validation use the same schema-derived unit limit", (t) => {
  const root = isolatedEngine(t, true);
  const schemaPath = path.join(root, "schemas/candidates.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.properties.unit_reviews.maxItems = 2;
  writeFileSync(schemaPath, JSON.stringify(schema));

  runModules(
    root,
    `
    import assert from "node:assert/strict";
    import { MAX_BATCH_UNITS } from "./scripts/review-contract.mjs";
    import { packUnitsIntoBatches } from "./scripts/review-planning.mjs";
    import { validateCandidateOutput } from "./scripts/review-results.mjs";

    assert.equal(MAX_BATCH_UNITS, 2);
    const units = [1, 2, 3].map(id => ({ id: String(id), group: "same", bytes: 1 }));
    const batches = packUnitsIntoBatches(units, 100);
    assert.deepEqual(batches.map(batch => batch.length), [2, 1]);
    assert.throws(
      () => validateCandidateOutput({ unit_reviews: [{}, {}, {}], findings: [] }, { units }),
      /unit_reviews must contain at most 2 entries/u
    );
  `
  );
});

test("candidate and verifier constraints follow schema changes together", (t) => {
  const root = isolatedEngine(t, true);
  const candidateSchemaPath = path.join(root, "schemas/candidates.schema.json");
  const candidateSchema = JSON.parse(readFileSync(candidateSchemaPath, "utf8"));
  candidateSchema.properties.findings.maxItems = 1;
  candidateSchema.properties.findings.items.properties.title.maxLength = 5;
  candidateSchema.properties.findings.items.properties.severity.enum = ["HIGH"];
  writeFileSync(candidateSchemaPath, JSON.stringify(candidateSchema));
  const verdictSchemaPath = path.join(root, "schemas/verdicts.schema.json");
  const verdictSchema = JSON.parse(readFileSync(verdictSchemaPath, "utf8"));
  verdictSchema.properties.verdicts.maxItems = 1;
  verdictSchema.properties.verdicts.items.properties.reason.maxLength = 4;
  writeFileSync(verdictSchemaPath, JSON.stringify(verdictSchema));
  runModules(
    root,
    `
    import assert from "node:assert/strict";
    import { validateCandidateOutput, prepareVerificationCandidates, validateVerdictOutput } from "./scripts/review-results.mjs";
    const batch = ${JSON.stringify(batch)};
    const output = ${JSON.stringify(candidateOutput({ title: "Valid" }))};
    const candidates = validateCandidateOutput(output, batch);
    assert.throws(() => validateCandidateOutput({ ...output, findings: [...output.findings, ...output.findings] }, batch), /at most 1/u);
    assert.throws(() => validateCandidateOutput({ ...output, findings: [{ ...output.findings[0], title: "Too long" }] }, batch), /1-5 characters/u);
    assert.throws(() => validateCandidateOutput({ ...output, findings: [{ ...output.findings[0], severity: "MEDIUM" }] }, batch), /invalid severity/u);
    assert.throws(() => prepareVerificationCandidates({ candidates: [...candidates, ...candidates], duplicates: 0 }), /more than 1/u);
    const verdict = { fingerprint: candidates[0].fingerprint, verdict: "CONFIRMED", confidence: "HIGH", reason: "Safe" };
    assert.equal(validateVerdictOutput({ verdicts: [verdict] }, candidates).size, 1);
    assert.throws(() => validateVerdictOutput({ verdicts: [verdict, verdict] }, candidates), /at most 1/u);
    assert.throws(() => validateVerdictOutput({ verdicts: [{ ...verdict, reason: "Too long" }] }, candidates), /1-4 characters/u);
  `
  );
});

test("repository configuration limits come from its schema", (t) => {
  const root = isolatedEngine(t, true);
  const schemaPath = path.join(root, "schemas/repository-config.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.properties.context.maxItems = 1;
  schema.properties.context.items.maxLength = 5;
  writeFileSync(schemaPath, JSON.stringify(schema));
  runModules(
    root,
    `
    import assert from "node:assert/strict";
    import { validateRepositoryConfig } from "./scripts/repository-config.mjs";
    assert.deepEqual(validateRepositoryConfig({ version: 1, context: ["a.md"] }, "/unused").context, ["a.md"]);
    assert.throws(() => validateRepositoryConfig({ version: 1, context: ["a.md", "b.md"] }, "/unused"), /at most 1/u);
    assert.throws(() => validateRepositoryConfig({ version: 1, context: ["long.md"] }, "/unused"), /5 characters/u);
  `
  );
});
