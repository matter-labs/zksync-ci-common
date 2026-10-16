import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);
const workflow = parse(readFileSync(new URL(".github/workflows/ai-security-review.yaml", root), "utf8"));

test("installed engine is callable without automatically reviewing repository pull requests", () => {
  assert.equal(workflow.env.AI_SECURITY_REVIEW_ENGINE_REPOSITORY, "matter-labs/zksync-ci-common");
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs), ["maximum_batches", "fail_on_findings"]);
  assert.equal(workflow.on.workflow_call.inputs.maximum_batches.default, 24);
  assert.equal(workflow.on.workflow_call.inputs.fail_on_findings.default, false);
  assert.equal(workflow.on.workflow_call.inputs.fail_on_findings.type, "boolean");
  assert.equal(workflow.on.workflow_call.secrets.ANTHROPIC_API_KEY.required, false);
  for (const name of ["prepare", "review", "verify"]) {
    assert.ok(statSync(new URL(`ai-security-review/actions/${name}/action.yml`, root)).isFile());
    const job = workflow.jobs[name];
    assert.ok(
      job.steps.some((step) => step.uses === `./.ai-security-review-engine/ai-security-review/actions/${name}`)
    );
  }
});

test("only publishers share a non-cancelling per-PR queue across runs and engine revisions", () => {
  assert.equal(workflow.concurrency, undefined);
  const queued = Object.entries(workflow.jobs).filter(([, job]) => job.concurrency);
  assert.deepEqual(
    queued.map(([name]) => name),
    ["publish"]
  );
  assert.deepEqual(workflow.jobs.publish.concurrency, {
    group: `matter-labs-ai-security-review-publish-\${{ github.repository }}-\${{ github.event.pull_request.number || github.run_id }}`,
    "cancel-in-progress": false,
    queue: "max"
  });
  assert.equal(workflow.jobs.publish.permissions["pull-requests"], "write");
  assert.ok(workflow.jobs.complete.needs.includes("publish"));
  for (const name of ["review", "verify"]) {
    assert.equal(workflow.jobs[name].permissions["pull-requests"], undefined);
  }
});

test("engine CI can be required on all pull requests and merge groups without model credentials", () => {
  const ci = parse(readFileSync(new URL(".github/workflows/ai-security-review-ci.yaml", root), "utf8"));
  assert.deepEqual(Object.keys(ci.on).sort(), ["merge_group", "pull_request", "push"]);
  assert.deepEqual(ci.on.push, { branches: ["main"] });
  assert.equal(ci.on.pull_request, null);
  assert.equal(ci.on.merge_group, null);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.equal(ci.jobs.test.name, "AI review engine checks");
  assert.ok(ci.jobs.test["timeout-minutes"] <= 30);
  assert.doesNotMatch(JSON.stringify(ci), /secrets\.|id-token|pull_request_target/u);
  const steps = ci.jobs.test.steps;
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(steps.some((step) => step.run === "node --test ai-security-review/test/*.test.mjs"));
  assert.ok(steps.some((step) => step.run === "node ai-security-review/scripts/smoke-test-claude-cli.mjs"));
});

test("external actions stay immutable and nested composite dependencies remain covered by updates", () => {
  const updates = parse(readFileSync(new URL(".github/dependabot.yml", root), "utf8")).updates;
  const actionDirectories = updates
    .filter((entry) => entry["package-ecosystem"] === "github-actions")
    .flatMap((entry) => entry.directories ?? [entry.directory]);
  assert.ok(actionDirectories.includes("/"));
  assert.ok(updates.some((entry) => entry["package-ecosystem"] === "npm" && entry.directory === "/ai-security-review"));
  const definitions = [
    workflow,
    parse(readFileSync(new URL(".github/workflows/ai-security-review-ci.yaml", root), "utf8"))
  ];
  for (const directory of readdirSync(new URL("ai-security-review/actions/", root))) {
    const action = parse(readFileSync(new URL(`ai-security-review/actions/${directory}/action.yml`, root), "utf8"));
    definitions.push(action);
    if (action.runs.steps.some((step) => step.uses && !step.uses.startsWith("./"))) {
      assert.ok(actionDirectories.includes(`/ai-security-review/actions/${directory}`), directory);
    }
  }
  for (const definition of definitions) {
    const steps = definition.runs?.steps ?? Object.values(definition.jobs).flatMap((job) => job.steps ?? []);
    for (const step of steps) {
      if (!step.uses || step.uses.startsWith("./")) continue;
      assert.match(step.uses, /^[^ @]+@[a-f0-9]{40}$/u);
    }
  }
});
