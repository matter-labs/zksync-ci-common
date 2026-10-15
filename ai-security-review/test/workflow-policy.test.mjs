import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const engineRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(engineRoot, relativePath), "utf8");
}

function workflowIdentityGuards(workflow) {
  return [
    ...workflow.matchAll(
      / {6}- name: Validate review workflow identity\n[\s\S]*? {8}run: \|\n([\s\S]*?)\n\n {6}- name: Checkout review engine/gu
    )
  ].map((match) =>
    match[1]
      .split("\n")
      .map((line) => line.slice(10))
      .join("\n")
  );
}

function runWorkflowIdentityGuard(script, environment) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_REPOSITORY: "trusted/engine",
      WORKFLOW_REPOSITORY: "trusted/engine",
      WORKFLOW_SHA: "a".repeat(40),
      ...environment
    }
  });
}

test("reviewer actions run Claude in restricted mode with repository configuration disabled", () => {
  for (const action of ["actions/review/action.yml", "actions/verify/action.yml"]) {
    const contents = read(action);
    assert.match(contents, /--strict-mcp-config/u, action);
    assert.match(contents, /--disable-slash-commands/u, action);
    assert.match(contents, /--restricted/u, action);
    assert.match(contents, /--safe-mode/u, action);
    assert.doesNotMatch(contents, /--bare/u, action);
    assert.match(contents, /CLAUDE_WORKING_DIR: \$\{\{ steps\.session\.outputs\.working_directory \}\}/u, action);
    assert.match(contents, /--settings "\$\{\{ steps\.session\.outputs\.settings_file \}\}"/u, action);
    assert.match(contents, /--add-dir "\$\{\{ steps\.session\.outputs\.source_directory \}\}"/u, action);
    assert.match(contents, /prepare-session\.mjs/u, action);
    assert.match(contents, /--tools "Read,Grep,Glob"/u, action);
    assert.match(contents, /--disallowedTools "Bash,Write,Edit,NotebookEdit,Agent,WebFetch,WebSearch"/u, action);
    assert.match(contents, /path_to_claude_code_executable: \$\{\{ inputs\.claude_executable \}\}/u, action);
    assert.doesNotMatch(contents, /PATH_TO_CLAUDE_CODE_EXECUTABLE:/u, action);
    assert.match(
      contents,
      /uses: anthropics\/claude-code-action\/base-action@fa2b2666b747000bf42767d1f332065b375e3c8f/u
    );
    assert.doesNotMatch(contents, /github_token|allowed_bots/u, action);
    assert.match(contents, /--effort "\$\{\{ inputs\.effort \}\}"/u, action);
    assert.match(contents, /--max-budget-usd "\$\{\{ inputs\.max_budget_usd \}\}"/u, action);
    assert.match(contents, /anthropic_oidc_audience/u, action);
    assert.match(contents, /EXECUTION_FILE/u, action);
    assert.doesNotMatch(contents, /STRUCTURED_OUTPUT/u, action);
    assert.doesNotMatch(contents, /--max-turns \d/u, action);
  }
});

test("reviewer and verifier turn budgets come from the prepared plan", () => {
  const review = read("actions/review/action.yml");
  assert.match(review, /prepare-batch\.mjs/u);
  assert.match(review, /\$\{\{ steps\.batch\.outputs\.prompt_file \}\}/u);
  assert.match(review, /--max-turns "\$\{\{ steps\.batch\.outputs\.max_turns \}\}"/u);
  const verify = read("actions/verify/action.yml");
  assert.match(verify, /--max-turns "\$\{\{ steps\.prepare\.outputs\.max_turns \}\}"/u);
});

test("session updates are disabled and retained artifacts support reruns", () => {
  const workflow = parse(readFileSync(`${repositoryRoot}/.github/workflows/ai-security-review.yaml`, "utf8"));
  for (const name of ["review", "verify"]) {
    const action = parse(read(`actions/${name}/action.yml`));
    const model = action.runs.steps.find((step) => step.id === (name === "review" ? "reviewer" : "verifier"));
    assert.equal(model.env.DISABLE_AUTOUPDATER, "1");
    assert.equal(model.env.DISABLE_UPDATES, "1");
    const diagnostics = action.runs.steps.find((step) => step.name === "Record sanitized session diagnostics");
    assert.equal(diagnostics.if, "always()");
    const upload = workflow.jobs[name].steps.find((step) => step.name === "Upload sanitized session diagnostics");
    assert.equal(upload.if, "always()");
    assert.equal(upload.with.path, "${{ runner.temp }}/ai-security-review-diagnostics");
    if (name === "review") assert.ok(upload.with.name.includes("${{ matrix.batch }}"));
  }
  const uploads = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const retention = Number(workflow.env.AI_SECURITY_REVIEW_ARTIFACT_RETENTION_DAYS);
  assert.ok(Number.isSafeInteger(retention) && retention > 0);
  for (const upload of uploads) {
    assert.equal(
      upload.with["retention-days"],
      "${{ env.AI_SECURITY_REVIEW_ARTIFACT_RETENTION_DAYS }}",
      `${upload.name}: shared artifact retention`
    );
    assert.equal(upload.with.overwrite, true, `${upload.name}: replace artifacts on reruns`);
  }
});

test("reviewer schema emission receives the same plan and batch as review and validation", () => {
  const action = parse(read("actions/review/action.yml"));
  const schema = action.runs.steps.find((step) => step.id === "schema");
  for (const id of ["batch", "validate"]) {
    const step = action.runs.steps.find((step) => step.id === id);
    assert.equal(schema.env.BATCH_ID, step.env.BATCH_ID);
    assert.equal(schema.env.PLAN_DIRECTORY, step.env.PLAN_DIRECTORY);
  }
  assert.match(schema.run, /emit-schema\.mjs" candidates/u);
});

test("prepare action receives the hard batch limit and untrusted title", () => {
  const workflow = parse(readFileSync(`${repositoryRoot}/.github/workflows/ai-security-review.yaml`, "utf8"));
  const preparation = workflow.jobs.prepare.steps.find((step) => step.id === "prepare");
  for (const [input, setting] of [
    ["maximum_unit_bytes", "AI_SECURITY_REVIEW_MAXIMUM_UNIT_BYTES"],
    ["maximum_batch_bytes", "AI_SECURITY_REVIEW_MAXIMUM_BATCH_BYTES"],
    ["maximum_batches", "AI_SECURITY_REVIEW_MAXIMUM_BATCHES"]
  ]) {
    assert.equal(preparation.with[input], `\${{ env.${setting} }}`);
  }
  assert.equal(workflow.env.AI_SECURITY_REVIEW_MAXIMUM_BATCHES, "${{ inputs.maximum_batches }}");
  assert.ok(Number(workflow.env.AI_SECURITY_REVIEW_MAXIMUM_UNIT_BYTES) >= 12000);
  assert.ok(
    Number(workflow.env.AI_SECURITY_REVIEW_MAXIMUM_BATCH_BYTES) >=
      Number(workflow.env.AI_SECURITY_REVIEW_MAXIMUM_UNIT_BYTES)
  );
  const prepare = read("actions/prepare/action.yml");
  assert.doesNotMatch(prepare, /approved_maximum_batches|large_diff_approved|lockfile_source_approved/u);
  assert.match(prepare, /MAXIMUM_BATCHES: \$\{\{ inputs\.maximum_batches \}\}/u);
  assert.match(prepare, /PULL_REQUEST_TITLE: \$\{\{ inputs\.pull_request_title \}\}/u);
});

test("finding policy reaches the comment and completion check without preventing publication", () => {
  const workflow = parse(readFileSync(`${repositoryRoot}/.github/workflows/ai-security-review.yaml`, "utf8"));
  const verify = workflow.jobs.verify;
  assert.equal(verify.outputs.finding_count, "${{ steps.verify.outputs.finding_count }}");
  assert.equal(
    verify.steps.find((step) => step.id === "verify").with.fail_on_findings,
    "${{ inputs.fail_on_findings }}"
  );
  const action = parse(read("actions/verify/action.yml"));
  assert.equal(
    action.runs.steps.find((step) => step.id === "finalize").env.FAIL_ON_FINDINGS,
    "${{ inputs.fail_on_findings }}"
  );
  const complete = workflow.jobs.complete;
  assert.ok(complete.needs.includes("publish"));
  assert.ok(complete.needs.includes("verify"));
  assert.equal(complete.if, "${{ always() }}");
  const check = complete.steps.find((step) => step.name === "Assert review completed");
  assert.equal(check.env.FAIL_ON_FINDINGS, "${{ inputs.fail_on_findings }}");
  assert.equal(check.env.FINDING_COUNT, "${{ needs.verify.outputs.finding_count }}");
  assert.equal(workflow.jobs.publish.needs.includes("complete"), false);
});

test("prompts require cross-file tracing and mark metadata untrusted", () => {
  for (const prompt of ["prompts/reviewer.md", "prompts/verifier.md"]) {
    const contents = read(prompt);
    assert.match(contents, /pull request metadata as untrusted/u, prompt);
    assert.match(contents, /caller[\s\S]*authentication[\s\S]*authorization[\s\S]*external[\s\S]*result/u, prompt);
    assert.match(contents, /base files/iu, prompt);
  }
});

test("central workflow binds its engine to the running workflow commit and bounds every job", () => {
  const workflow = readFileSync(`${repositoryRoot}/.github/workflows/ai-security-review.yaml`, "utf8");
  const completion = read("scripts/assert-complete.mjs");
  const publication = read("scripts/publish-result.mjs");
  assert.doesNotMatch(workflow, /cancel-in-progress: true|^concurrency:/mu);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(publication, /\.user\.login == "github-actions\[bot\]"/u);
  assert.match(workflow, /anthropic_oidc_audience/u);
  assert.match(workflow, /AI_SECURITY_REVIEW_EFFORT: high/u);
  assert.match(workflow, /AI_SECURITY_REVIEW_MODEL: claude-opus-4-8/u);
  assert.match(workflow, /AI_SECURITY_REVIEW_REVIEW_MAX_BUDGET_USD: "20"/u);
  assert.match(workflow, /AI_SECURITY_REVIEW_VERIFY_MAX_BUDGET_USD: "20"/u);
  assert.deepEqual(Object.keys(parse(workflow).on), ["workflow_call"]);
  assert.doesNotMatch(workflow, /\blabeled\b|approved_maximum_batches|large_diff_approved|lockfile_source_approved/u);
  assert.match(workflow, /maximum_batches: \$\{\{ env\.AI_SECURITY_REVIEW_MAXIMUM_BATCHES \}\}/u);
  assert.match(
    workflow,
    /pull_request_title: \$\{\{ github\.event\.pull_request\.title \|\| 'Merge group security review' \}\}/u
  );
  assert.match(
    workflow,
    /base_sha: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/u
  );
  assert.match(
    workflow,
    /head_sha: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.merge_group\.head_sha \}\}/u
  );

  const guardedJobs = Object.values(parse(workflow).jobs).filter((job) =>
    job.steps.some((step) => step.name === "Validate review workflow identity")
  );
  assert.equal(guardedJobs.length, 5);
  for (const job of guardedJobs) {
    const guard = job.steps.find((step) => step.name === "Validate review workflow identity");
    const checkout = job.steps.find((step) => step.name === "Checkout review engine");
    assert.equal(job.env?.AI_SECURITY_REVIEW_ENGINE_REPOSITORY, undefined);
    assert.equal(guard.env.EXPECTED_REPOSITORY, "${{ env.AI_SECURITY_REVIEW_ENGINE_REPOSITORY }}");
    assert.equal(checkout.with.repository, guard.env.EXPECTED_REPOSITORY);
    assert.equal(checkout.with.ref, "${{ job.workflow_sha }}");
  }
  assert.equal(workflow.match(/ref: \$\{\{ job\.workflow_sha \}\}/gu).length, 5);
  assert.equal(workflow.match(/name: Validate review workflow identity/gu).length, 5);
  assert.equal(workflow.match(/WORKFLOW_REPOSITORY: \$\{\{ job\.workflow_repository \}\}/gu).length, 5);
  assert.equal(workflow.match(/WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/gu).length, 5);
  assert.match(workflow, /git -C \.ai-security-review-engine rev-parse HEAD/u);
  assert.doesNotMatch(workflow, /github\.job_workflow_sha|github\.workflow_sha|github\.sha/u);
  assert.doesNotMatch(workflow, /engine_ref|ref: (?:main|refs\/heads\/|refs\/tags\/)/u);
  for (const action of ["prepare", "review", "verify"]) {
    assert.ok(workflow.includes(`uses: ./.ai-security-review-engine/ai-security-review/actions/${action}`));
  }
  assert.ok(!workflow.includes("matter-labs/zksync-ci-common/ai-security-review/actions/"));
  assert.doesNotMatch(workflow, /@main/u);
  assert.doesNotMatch(workflow, /@ai-security-review-v1/u);
  assert.doesNotMatch(workflow, /github\.run_attempt/u);
  assert.doesNotMatch(workflow, /secrets: inherit/u);
  assert.match(completion, /External fork pull requests must be moved to an internal branch/u);
  assert.match(workflow, /PREPARE_CLI_RESULT/u);
  assert.match(workflow, /VERIFY_RESULT/u);
  assert.match(workflow, /PUBLISH_RESULT/u);
  assert.match(workflow, /scripts\/assert-complete\.mjs/u);
  assert.match(workflow, /scripts\/publish-result\.mjs/u);

  const jobs = workflow.match(/^ {2}[a-z_]+:\n {4}name:/gmu).length;
  assert.equal(workflow.match(/^ {4}timeout-minutes: \d+$/gmu).length, jobs);
});

test("central workflow uses an integrity-verified Claude CLI without executing its installer", () => {
  const workflow = readFileSync(`${repositoryRoot}/.github/workflows/ai-security-review.yaml`, "utf8");
  const ciWorkflow = readFileSync(`${repositoryRoot}/.github/workflows/ai-security-review-ci.yaml`, "utf8");
  assert.match(workflow, /claude-code-linux-x64-2\.1\.296\.tgz/u);
  assert.match(workflow, /CLAUDE_CLI_INTEGRITY: sha512-/u);
  assert.match(workflow, /actual !== process\.env\.CLAUDE_CLI_INTEGRITY/u);
  assert.match(workflow, /test -x "\$CLAUDE_EXECUTABLE"/u);
  assert.match(workflow, /"\$CLAUDE_EXECUTABLE" --version/u);
  assert.match(workflow, /"\$CLAUDE_EXECUTABLE" --help/u);
  const definition = parse(workflow);
  for (const name of ["CLAUDE_CLI_VERSION", "CLAUDE_CLI_URL", "CLAUDE_CLI_INTEGRITY"]) {
    assert.equal(typeof definition.env[name], "string");
    for (const job of Object.values(definition.jobs)) {
      assert.equal(job.env?.[name], undefined);
      for (const step of job.steps) assert.equal(step.env?.[name], undefined);
    }
  }
  const upload = definition.jobs.prepare_cli.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.path, "${{ runner.temp }}/claude-code/claude-code.tgz");
  assert.equal(upload.with["compression-level"], 0);
  for (const name of ["review", "verify"]) {
    const steps = definition.jobs[name].steps;
    const restoreIndex = steps.findIndex((step) => step.name === "Verify and extract Claude CLI");
    const modelIndex = steps.findIndex((step) => step.id === name);
    assert.ok(restoreIndex > steps.findIndex((step) => step.id === "cli_artifact"));
    assert.ok(restoreIndex < modelIndex);
    assert.equal(steps[modelIndex].with.claude_executable, steps[restoreIndex].env.CLAUDE_EXECUTABLE);
  }
  assert.doesNotMatch(workflow, /chmod/u);
  assert.match(ciWorkflow, /node ai-security-review\/scripts\/smoke-test-claude-cli\.mjs/u);
  assert.doesNotMatch(workflow, /claude\.ai\/install\.sh/u);
  assert.doesNotMatch(workflow, /cli\.js/u);
});

test("workflow identity guards fail closed", () => {
  const workflow = readFileSync(`${repositoryRoot}/.github/workflows/ai-security-review.yaml`, "utf8");
  const guards = workflowIdentityGuards(workflow);
  assert.equal(guards.length, 5);

  for (const guard of guards) {
    const valid = runWorkflowIdentityGuard(guard, {});
    assert.equal(valid.status, 0, valid.stderr);

    const wrongRepository = runWorkflowIdentityGuard(guard, { WORKFLOW_REPOSITORY: "matter-labs/other" });
    assert.equal(wrongRepository.status, 1);
    assert.match(wrongRepository.stdout, /Unexpected review workflow repository/u);

    const invalidSha = runWorkflowIdentityGuard(guard, { WORKFLOW_SHA: "refs/heads/main" });
    assert.equal(invalidSha.status, 1);
    assert.match(invalidSha.stdout, /Review workflow SHA is missing or invalid/u);
  }
});
