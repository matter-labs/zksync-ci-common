import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { parse } from "yaml";

const generator = fileURLToPath(new URL("../examples/create-caller.mjs", import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "review-caller-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("caller examples generate immutable pins without inherited secrets or fork write access", (t) => {
  for (const template of ["pull-requests", "labelled-drafts", "merge-queue", "required-review"]) {
    const cwd = fixture(t);
    const sha = "a".repeat(40);
    const result = spawnSync(process.execPath, [generator, sha, template], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const file = path.join(cwd, ".github/workflows/ai-security-review-caller.yaml");
    const text = readFileSync(file, "utf8");
    const workflow = parse(text);
    const job = workflow.jobs["ai-security-review"];
    assert.equal(job.uses, `matter-labs/zksync-ci-common/.github/workflows/ai-security-review.yaml@${sha}`);
    assert.deepEqual(workflow.permissions, {});
    assert.equal(job.secrets, undefined);
    assert.equal(workflow.on.pull_request_target, undefined);
    assert.ok(job.if.includes("github.event.pull_request.head.repo.full_name == github.repository"));
    assert.ok(job.if.includes("github.actor != 'dependabot[bot]'"));
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.equal(job.with.maximum_batches, 24);
    assert.equal(job.with.fail_on_findings, template === "required-review" ? true : undefined);
    assert.deepEqual(job.permissions, { contents: "read", "id-token": "write", "pull-requests": "write" });
    assert.equal(job.if.includes("!github.event.pull_request.draft"), template !== "labelled-drafts");
    assert.equal(job.if.includes("contains("), template === "labelled-drafts");
    assert.equal(Boolean(workflow.on.merge_group), ["merge-queue", "required-review"].includes(template));
    assert.equal(workflow.on.pull_request.types.includes("labeled"), template === "labelled-drafts");
    const again = spawnSync(process.execPath, [generator, "b".repeat(40), template], { cwd, encoding: "utf8" });
    assert.notEqual(again.status, 0);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("revision setup accepts only main ancestors and checks engine files afterward", (t) => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("### Verify an Engine Revision\n")[1]?.split("\n### ")[0];
  const script = section?.split("```bash\n")[1]?.split("\n```")[0];
  assert.ok(script, "README must contain the runnable revision check");
  const sha = "a".repeat(40);
  const repository = "repos/matter-labs/zksync-ci-common";
  const compareCall = `api ${repository}/compare/${sha}...main --jq .status`;
  const workflowCall = `api --silent ${repository}/contents/.github/workflows/ai-security-review.yaml?ref=${sha}`;
  const actionCall = `api --silent ${repository}/contents/ai-security-review/actions/prepare/action.yml?ref=${sha}`;
  const fakeGh = `
    gh() {
      printf '%s\\n' "$*" >> "$GH_CALL_LOG"
      if [[ "$*" == *"/compare/"* ]]; then
        printf '%s\\n' "$GH_COMPARE_STATUS"
        return "$GH_COMPARE_EXIT"
      fi
      if [[ "$*" == *"$GH_MISSING_FILE"* ]]; then return 1; fi
    }
  `;
  for (const scenario of [
    { status: "ahead", accepted: true },
    { status: "identical", accepted: true },
    { status: "behind" },
    { status: "diverged" },
    { status: "unknown" },
    { status: "" },
    { status: "ahead", compareExit: "1" },
    { status: "ahead", missingFile: ".github/workflows/ai-security-review.yaml" },
    { status: "ahead", missingFile: "ai-security-review/actions/prepare/action.yml" }
  ]) {
    const cwd = fixture(t);
    const callLog = path.join(cwd, "gh-calls");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${fakeGh}\n${script}`], {
      cwd,
      input: `${sha}\n`,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_CALL_LOG: callLog,
        GH_COMPARE_STATUS: scenario.status,
        GH_COMPARE_EXIT: scenario.compareExit ?? "0",
        GH_MISSING_FILE: scenario.missingFile ?? "no-missing-file"
      }
    });
    assert.equal(result.status, scenario.accepted ? 0 : 1, `${JSON.stringify(scenario)}: ${result.stderr}`);
    const expectedCalls = [compareCall];
    if (scenario.accepted || scenario.missingFile) expectedCalls.push(workflowCall);
    if (scenario.accepted || scenario.missingFile === "ai-security-review/actions/prepare/action.yml") {
      expectedCalls.push(actionCall);
    }
    assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), expectedCalls);
  }
});

test("labelled drafts review the selected label and pushes without repeating unrelated label or readiness events", () => {
  const workflow = parse(readFileSync(new URL("../examples/callers/labelled-drafts.yaml", import.meta.url), "utf8"));
  const expression = workflow.jobs["ai-security-review"].if.replace(
    "github.event.pull_request.labels.*.name",
    "labelNames"
  );
  const condition = new Script(expression);
  for (const scenario of [
    { action: "opened", expected: true },
    { action: "reopened", expected: true },
    { action: "synchronize", expected: true },
    { action: "synchronize", draft: false, expected: true },
    { action: "labeled", label: "ai-security-review", expected: true },
    { action: "labeled", label: "documentation", expected: false },
    { action: "ready_for_review", draft: false, expected: false },
    { action: "synchronize", labels: [], expected: false },
    { action: "synchronize", actor: "dependabot[bot]", expected: false },
    { action: "synchronize", headRepository: "contributor/project", expected: false }
  ]) {
    const github = {
      repository: "example/project",
      actor: scenario.actor ?? "maintainer",
      event: {
        action: scenario.action,
        label: { name: scenario.label },
        pull_request: {
          draft: scenario.draft ?? true,
          head: { repo: { full_name: scenario.headRepository ?? "example/project" } }
        }
      }
    };
    const scheduled =
      workflow.on.pull_request.types.includes(scenario.action) &&
      condition.runInNewContext(
        {
          github,
          labelNames: scenario.labels ?? ["ai-security-review"],
          contains: (values, value) => values.includes(value)
        },
        { timeout: 100 }
      );
    assert.equal(scheduled, scenario.expected, JSON.stringify(scenario));
  }
});

test("required caller check rejects failed, cancelled, skipped or missing review results", () => {
  const workflow = parse(readFileSync(new URL("../examples/callers/required-review.yaml", import.meta.url), "utf8"));
  const gate = workflow.jobs["required-review"];
  assert.equal(gate.name, "AI security review required");
  assert.equal(gate.if, "${{ always() }}");
  assert.deepEqual(gate.needs, ["ai-security-review"]);
  assert.deepEqual(gate.permissions, {});
  assert.equal(gate.steps.length, 1);
  assert.equal(gate.steps[0].env.REVIEW_RESULT, "${{ needs.ai-security-review.result }}");
  for (const outcome of ["success", "failure", "cancelled", "skipped", ""]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", gate.steps[0].run], {
      env: { ...process.env, REVIEW_RESULT: outcome },
      encoding: "utf8"
    });
    assert.equal(result.status, outcome === "success" ? 0 : 1, result.stderr);
  }
});

test("caller generation rejects moving refs, malformed pins and arbitrary template paths", (t) => {
  const cwd = fixture(t);
  for (const args of [
    [],
    ["main"],
    ["a".repeat(41)],
    ["a".repeat(40), "../README"],
    ["a".repeat(40), "pull-requests", "extra"]
  ]) {
    const result = spawnSync(process.execPath, [generator, ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/u);
  }
});
