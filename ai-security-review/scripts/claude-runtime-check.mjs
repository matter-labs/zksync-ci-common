import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { createClaudeSession } from "./claude-session.mjs";
import { sessionFailure } from "./review-diagnostics.mjs";
import { assertPatchReadCoverage } from "./script-utils.mjs";
import { reviewerOutputSchema } from "./reviewer-output.mjs";

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function respond(response, payload, stream) {
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (name, value) => response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  event("message_start", { type: "message_start", message: { ...payload, content: [], stop_reason: null } });
  payload.content.forEach((block, index) => {
    event("content_block_start", {
      type: "content_block_start",
      index,
      content_block: block.type === "tool_use" ? { ...block, input: {} } : { ...block, text: "" }
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index,
      delta:
        block.type === "tool_use"
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.text }
    });
    event("content_block_stop", { type: "content_block_stop", index });
  });
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: payload.stop_reason, stop_sequence: null },
    usage: { output_tokens: 50 }
  });
  event("message_stop", { type: "message_stop" });
  response.end();
}

function actionArguments(action, substitutions) {
  let rendered = action.runs.steps.find((step) => step.uses?.startsWith("anthropics/claude-code-action/")).with
    .claude_args;
  for (const [key, value] of Object.entries(substitutions)) rendered = rendered.replaceAll(`\${{ ${key} }}`, value);
  assert(!rendered.includes("${{"), "runtime test did not resolve every action input");
  return [...rendered.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? match[3]);
}

async function runAction(executable, actionName, root, scenario = "coverage") {
  const sourceDirectory = path.join(root, actionName, "source");
  const engineRoot = path.join(sourceDirectory, ".ai-security-review-engine", "ai-security-review");
  const plan = path.join(root, actionName, "plan");
  const verification = path.join(root, actionName, "verification");
  const credentials = path.join(root, "credentials", "identity-token");
  const marker = path.join(root, "unexpected-startup-marker");
  mkdirSync(engineRoot, { recursive: true });
  mkdirSync(verification, { recursive: true });
  write(credentials, "CREDENTIAL_CANARY");
  write(path.join(sourceDirectory, ".git", "config"), "GIT_CANARY");
  write(path.join(engineRoot, "private.txt"), "ENGINE_CANARY");
  write(path.join(sourceDirectory, "normal.txt"), "ordinary source\n");
  write(path.join(sourceDirectory, "CLAUDE.md"), "STARTUP_INSTRUCTION_CANARY");
  write(
    path.join(sourceDirectory, ".claude", "skills", "unsafe", "SKILL.md"),
    "---\nname: unsafe\ndescription: STARTUP_SKILL_CANARY\n---\nDo not load.\n"
  );
  write(
    path.join(sourceDirectory, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] } })
  );
  write(
    path.join(sourceDirectory, ".mcp.json"),
    JSON.stringify({ mcpServers: { unsafe: { command: "touch", args: [marker] } } })
  );
  const patch = path.join(plan, "unit.patch");
  write(patch, `first\r\n${"x".repeat(5000)}\r\n`);
  const latePatch = path.join(plan, "late.patch");
  write(latePatch, "later unit\n");
  const batch = {
    units: [
      { id: "unit-0001", path: "first.ts", patchFile: "unit.patch", lines: 3, changedLines: [1] },
      { id: "unit-0073", path: "later.ts", patchFile: "late.patch", lines: 2, changedLines: [60, 61, 90] }
    ]
  };
  symlinkSync(credentials, path.join(sourceDirectory, "outside-link"));
  symlinkSync(path.join(engineRoot, "private.txt"), path.join(sourceDirectory, "engine-link"));
  const session = createClaudeSession({ sourceDirectory, engineRoot, temporaryDirectory: root });
  const cases = [
    ["patch", "Read", { file_path: patch }, false],
    ["late-patch", "Read", { file_path: latePatch }, false],
    ["normal", "Read", { file_path: path.join(sourceDirectory, "normal.txt") }, false],
    ["git", "Read", { file_path: path.join(sourceDirectory, ".git", "config") }, true],
    ["engine", "Read", { file_path: path.join(engineRoot, "private.txt") }, true],
    ["credential", "Read", { file_path: credentials }, true],
    ["outside-link", "Read", { file_path: path.join(sourceDirectory, "outside-link") }, true],
    ["engine-link", "Read", { file_path: path.join(sourceDirectory, "engine-link") }, true],
    ["grep", "Grep", { pattern: "ordinary", path: sourceDirectory, output_mode: "content" }, false],
    ["glob", "Glob", { pattern: "*.txt", path: sourceDirectory }, false],
    ["grep-denied", "Grep", { pattern: ".", path: path.join(sourceDirectory, ".git"), output_mode: "content" }, true],
    ["glob-denied", "Glob", { pattern: "*", path: path.dirname(credentials) }, true],
    ["parent-grep", "Grep", { pattern: "CANARY", path: sourceDirectory, glob: "**/*", output_mode: "content" }, false],
    ["command", "Bash", { command: `touch ${marker}` }, true]
  ];
  const structured =
    actionName === "review"
      ? {
          unit_reviews: {
            "unit-0001": { status: "CLEAN", evidence_line: 1, summary: "Fixture read." },
            "unit-0073": { status: "CLEAN", evidence_line: 60, summary: "Later fixture read." }
          },
          findings: []
        }
      : { verdicts: [] };
  const results = new Map();
  let requestCount = 0;
  let initial;
  let schemaRejected = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.end('{"input_tokens":100}');
      return;
    }
    const input = JSON.parse(body);
    if (
      input.tools?.some((tool) =>
        ["oneOf", "allOf", "anyOf"].some((key) => Object.hasOwn(tool.input_schema ?? {}, key))
      )
    ) {
      schemaRejected = true;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "tools.2.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level"
          }
        })
      );
      return;
    }
    const review = input.tools?.some((tool) => tool.name === "Read");
    if (review) {
      initial ??= input;
      for (const message of input.messages ?? []) {
        if (message.role !== "user" || !Array.isArray(message.content)) continue;
        for (const block of message.content) if (block.type === "tool_result") results.set(block.tool_use_id, block);
      }
    }
    const index = review ? requestCount++ : -1;
    const phase = actionName === "review" && scenario === "findings" && index > 0 ? index + 3 : index;
    let content = [{ type: "text", text: "Complete." }];
    if (index === 0) {
      content = cases.map(([id, name, toolInput]) => ({ type: "tool_use", id, name, input: toolInput }));
    } else if (actionName === "review" && phase === 1) {
      content = [
        {
          type: "tool_use",
          id: "structured-incomplete",
          name: "StructuredOutput",
          input: { ...structured, unit_reviews: { "unit-0001": structured.unit_reviews["unit-0001"] } }
        }
      ];
    } else if (actionName === "review" && phase === 2) {
      const invalid = structuredClone(structured);
      invalid.unit_reviews["unit-0073"].evidence_line = 1;
      content = [{ type: "tool_use", id: "structured-invalid-evidence", name: "StructuredOutput", input: invalid }];
    } else if (actionName === "review" && scenario === "findings" && (phase === 4 || phase === 5)) {
      const invalid = structuredClone(structured);
      invalid.unit_reviews["unit-0073"].status = "FINDING";
      invalid.findings = [
        {
          unit_id: "unit-0073",
          file: phase === 4 ? "wrong.ts" : "later.ts",
          line: phase === 5 ? 1 : 60,
          severity: "HIGH",
          confidence: "HIGH",
          title: "Fixture finding",
          evidence: "Fixture evidence",
          description: "Fixture description",
          attack_scenario: "Fixture attack",
          impact: "Fixture impact",
          remediation: "Fixture remediation"
        }
      ];
      content = [
        {
          type: "tool_use",
          id: phase === 4 ? "structured-invalid-file" : "structured-invalid-line",
          name: "StructuredOutput",
          input: invalid
        }
      ];
    } else if (index === (actionName === "review" ? 3 : 1)) {
      content = [{ type: "tool_use", id: "structured", name: "StructuredOutput", input: structured }];
    }
    respond(
      response,
      {
        id: "fixture-message",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content,
        stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 }
      },
      input.stream
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const action = parse(readFileSync(new URL(`../actions/${actionName}/action.yml`, import.meta.url), "utf8"));
    const schema =
      actionName === "review"
        ? reviewerOutputSchema(batch)
        : JSON.parse(readFileSync(new URL("../schemas/verdicts.schema.json", import.meta.url), "utf8"));
    if (scenario === "schema-rejection") schema.allOf = [{}];
    const args = actionArguments(action, {
      "inputs.model": "claude-opus-4-8",
      "inputs.effort": "high",
      "inputs.max_budget_usd": "1",
      "steps.batch.outputs.max_turns": "40",
      "steps.prepare.outputs.max_turns": "40",
      "steps.schema.outputs.schema": JSON.stringify(schema),
      "inputs.plan_directory": plan,
      "inputs.verification_directory": verification,
      "steps.session.outputs.source_directory": session.sourceDirectory,
      "steps.session.outputs.settings_file": session.settingsFile
    });
    const child = spawn(
      executable,
      [
        "-p",
        "Inspect the fixtures.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        ...args
      ],
      {
        cwd: session.workingDirectory,
        env: {
          PATH: "/usr/bin:/bin",
          CLAUDE_CONFIG_DIR: path.join(root, actionName, "config"),
          ANTHROPIC_API_KEY: "dummy-local-test-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          DISABLE_AUTOUPDATER: "1",
          DISABLE_UPDATES: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_ACTION: "1",
          CLAUDE_CODE_ENTRYPOINT: "claude-code-github-action",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1"
        }
      }
    );
    child.stdin.end();
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let exitCode;
    try {
      exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(exitCode, scenario === "schema-rejection" ? 1 : 0, stderr);
    const messages = stdout.trim().split("\n").map(JSON.parse);
    if (scenario === "schema-rejection") {
      assert.ok(schemaRejected, "the fake API must reject the intentionally invalid schema");
      assert.equal(messages.findLast((message) => message.type === "result")?.is_error, true);
      assert.deepEqual(sessionFailure(messages), {
        code: "api-invalid-request",
        http_status: 400,
        field: "tools.2.custom.input_schema",
        reason: "unsupported-root-schema-combinator"
      });
      console.log("Verified schema-rejection diagnostics from actual CLI output with a local fake API.");
      return;
    }
    // Newer CLI builds list a placeholder for ToolSearch-deferred tools; nothing is deferred here.
    const toolNames = initial.tools.map((tool) => tool.name).filter((name) => name !== "DeferredToolPlaceholder");
    assert.deepEqual(toolNames.sort(), ["Glob", "Grep", "Read", "StructuredOutput"]);
    assert(!JSON.stringify(initial).includes("STARTUP_INSTRUCTION_CANARY"));
    assert(!JSON.stringify(initial).includes("STARTUP_SKILL_CANARY"));
    assert(!existsSync(marker));
    for (const [id, , , denied] of cases) {
      assert(results.has(id), `missing ${actionName} result: ${id}`);
      assert.equal(results.get(id).is_error === true, denied, id);
      assert(!/CREDENTIAL_CANARY|GIT_CANARY|ENGINE_CANARY/u.test(JSON.stringify(results.get(id))), id);
    }
    assert.deepEqual(messages.find((message) => message.type === "result").structured_output, structured);
    if (actionName === "review" && scenario === "findings") {
      for (const id of ["structured-invalid-file", "structured-invalid-line"]) {
        assert.equal(results.get(id)?.is_error, true, `SDK must reject ${id}`);
      }
    }
    if (actionName === "review" && scenario === "coverage") {
      assert.equal(results.get("structured-incomplete")?.is_error, true, "SDK must reject the missing disposition");
      assert.match(JSON.stringify(results.get("structured-incomplete")), /unit-0073/u);
      assert.equal(
        results.get("structured-invalid-evidence")?.is_error,
        true,
        "SDK must reject a citation outside the assigned unit's changed lines"
      );
      assert.match(JSON.stringify(results.get("structured-invalid-evidence")), /evidence_line/u);
    }
    assertPatchReadCoverage(messages, batch, plan);
    console.log(
      `Verified ${actionName} runtime isolation, read coverage, and structured output with a local fake API.`
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function assertClaudeRuntime(executable) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-runtime-check-"));
  try {
    await runAction(executable, "review", path.join(root, "coverage"));
    await runAction(executable, "review", path.join(root, "findings"), "findings");
    await runAction(executable, "verify", path.join(root, "verifier"));
    await runAction(executable, "review", path.join(root, "schema-rejection"), "schema-rejection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
