import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COMMENT_MARKER } from "../scripts/comment-contract.mjs";
import { renderComment } from "../scripts/rendering.mjs";
import {
  buildFinalResult,
  mergeCandidateLists,
  validateCandidateOutput,
  validateVerdictOutput
} from "../scripts/review-results.mjs";
import { batch, candidateOutput, commentBoundaryOutput } from "./candidate-fixture.mjs";

const script = fileURLToPath(new URL("../scripts/publish-result.mjs", import.meta.url));
const headSha = "a".repeat(40);

function runPublication({ comments = "", result, comment, currentHeadSha = headSha, reviewedHeadSha = headSha }) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ai-security-review-publish-"));
  const binaryDirectory = path.join(temporaryRoot, "bin");
  const resultDirectory = path.join(temporaryRoot, "result");
  const logFile = path.join(temporaryRoot, "gh-calls.jsonl");
  const commentsFile = path.join(temporaryRoot, "comments.json");
  if (Array.isArray(comments)) writeFileSync(commentsFile, JSON.stringify(comments));
  mkdirSync(binaryDirectory);
  mkdirSync(resultDirectory);
  const fakeGh = path.join(binaryDirectory, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (process.argv.some((value) => value.endsWith("/pulls/42"))) process.stdout.write(process.env.FAKE_GH_HEAD);
else if (process.env.FAKE_GH_COMMENTS_FILE) {
  const comments = JSON.parse(readFileSync(process.env.FAKE_GH_COMMENTS_FILE, "utf8"));
  if (args.includes("--paginate")) {
    const selected = spawnSync("jq", ["-r", args[args.indexOf("--jq") + 1]], {
      input: JSON.stringify(comments), encoding: "utf8"
    });
    if (selected.status !== 0) throw new Error(selected.stderr || "Comment selector failed");
    process.stdout.write(selected.stdout);
  } else {
    const method = args[args.indexOf("--method") + 1];
    const endpoint = args.find((value) => value.startsWith("repos/"));
    const id = Number(endpoint.split("/").at(-1));
    const index = comments.findIndex((comment) => comment.id === id);
    if (method === "DELETE") {
      if (index === -1) throw new Error("Comment not found");
      comments.splice(index, 1);
    } else {
      const { body } = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      if (method === "POST") comments.push({ id: Math.max(0, ...comments.map((comment) => comment.id)) + 1, user: { login: "github-actions[bot]" }, body });
      else if (method === "PATCH" && index !== -1) comments[index].body = body;
      else throw new Error("Unexpected comment mutation");
    }
    writeFileSync(process.env.FAKE_GH_COMMENTS_FILE, JSON.stringify(comments));
  }
}
else if (process.argv.includes("--paginate")) process.stdout.write(process.env.FAKE_GH_COMMENTS || "");
`
  );
  chmodSync(fakeGh, 0o755);
  if (result !== undefined) writeFileSync(path.join(resultDirectory, "result.json"), JSON.stringify(result));
  if (comment !== undefined) writeFileSync(path.join(resultDirectory, "comment.md"), comment);

  const processResult = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GH_COMMENTS: Array.isArray(comments) ? "" : comments,
      FAKE_GH_COMMENTS_FILE: Array.isArray(comments) ? commentsFile : "",
      FAKE_GH_HEAD: currentHeadSha,
      FAKE_GH_LOG: logFile,
      GH_TOKEN: "test-token",
      HEAD_SHA: reviewedHeadSha,
      PATH: `${binaryDirectory}:${process.env.PATH}`,
      PR_NUMBER: "42",
      REPOSITORY: "matter-labs/fixture",
      RESULT_DIRECTORY: resultDirectory,
      RUNNER_TEMP: temporaryRoot,
      RUN_URL: "https://github.com/matter-labs/fixture/actions/runs/1"
    }
  });
  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    temporaryRoot,
    processResult,
    calls,
    comments: Array.isArray(comments) ? JSON.parse(readFileSync(commentsFile, "utf8")) : undefined
  };
}

function unrelatedComments() {
  return [
    { id: 1, user: { login: "github-actions[bot]" }, body: "<!-- ai-security-review-status -->\nLegacy failure" },
    { id: 2, user: { login: "human-reviewer" }, body: `${COMMENT_MARKER}\nHuman discussion` },
    { id: 3, user: { login: "other-app[bot]" }, body: `${COMMENT_MARKER}\nOther bot` },
    { id: 4, user: { login: "github-actions[bot]" }, body: `Quoted marker: ${COMMENT_MARKER}` },
    { id: 5, user: { login: "github-actions[bot]" }, body: "Legacy security finding" }
  ];
}

test("publication never mutates legacy, human, other-bot, or quoted-marker comments", (t) => {
  const findings = {
    status: "complete",
    head_sha: headSha,
    findings: validateCandidateOutput(candidateOutput(), batch)
  };
  const clean = { status: "complete", head_sha: headSha, findings: [] };
  const notice = { ...clean, dependency_review: { unclassified: 1 } };
  for (const result of [findings, clean, notice, undefined]) {
    const unrelated = unrelatedComments();
    const fixture = runPublication({
      comments: [
        ...unrelated,
        { id: 101, user: { login: "github-actions[bot]" }, body: `${COMMENT_MARKER}\nOld result` },
        { id: 102, user: { login: "github-actions[bot]" }, body: `${COMMENT_MARKER}\nDuplicate` }
      ],
      result,
      comment: result ? renderComment(result) : undefined
    });
    t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
    assert.equal(fixture.processResult.status, result ? 0 : 1, fixture.processResult.stderr);
    assert.deepEqual(
      fixture.comments.filter((comment) => comment.id < 100),
      unrelated
    );
    const owned = fixture.comments.filter((comment) => comment.id >= 100);
    assert.equal(owned.length, 1);
    if (owned.length) assert.equal(owned[0].id, 101);
  }
});

test("queued publishers reuse one owned comment and reject an older head after a newer result", (t) => {
  const result = { status: "complete", head_sha: headSha, findings: validateCandidateOutput(candidateOutput(), batch) };
  const newerSha = "b".repeat(40);
  const newerResult = { ...result, head_sha: newerSha };
  let comments = unrelatedComments();
  for (const [nextResult, currentHeadSha] of [
    [result, headSha],
    [result, headSha],
    [newerResult, newerSha],
    [result, newerSha]
  ]) {
    const fixture = runPublication({
      comments,
      result: nextResult,
      comment: renderComment(nextResult),
      currentHeadSha,
      reviewedHeadSha: nextResult.head_sha
    });
    t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
    assert.equal(fixture.processResult.status, 0, fixture.processResult.stderr);
    assert.deepEqual(fixture.comments.slice(0, 5), unrelatedComments());
    assert.equal(fixture.comments.length, 6);
    if (currentHeadSha !== nextResult.head_sha) {
      assert.deepEqual(fixture.comments, comments);
      assert.equal(fixture.calls.length, 1);
    } else {
      assert.equal(fixture.comments.at(-1).body, renderComment(nextResult));
    }
    comments = fixture.comments;
  }
});

test("publication updates one bot-owned sticky comment and deletes duplicates", () => {
  const result = { status: "complete", head_sha: headSha, findings: validateCandidateOutput(candidateOutput(), batch) };
  const fixture = runPublication({
    comments: "101\n102\n",
    result,
    comment: renderComment(result)
  });
  try {
    assert.equal(fixture.processResult.status, 0, fixture.processResult.stderr);
    assert.ok(fixture.calls.some((call) => call.includes("repos/matter-labs/fixture/issues/comments/101")));
    assert.ok(fixture.calls.some((call) => call.includes("PATCH")));
    assert.ok(fixture.calls.some((call) => call.includes("repos/matter-labs/fixture/issues/comments/102")));
    assert.ok(fixture.calls.some((call) => call.includes("DELETE")));
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("publication updates the existing comment after a clean result", () => {
  const result = { status: "complete", head_sha: headSha, findings: [] };
  const fixture = runPublication({
    comments: "101\n",
    result,
    comment: renderComment(result)
  });
  try {
    assert.equal(fixture.processResult.status, 0, fixture.processResult.stderr);
    assert.ok(!fixture.calls.some((call) => call.includes("DELETE")));
    assert.ok(fixture.calls.some((call) => call.includes("PATCH")));
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("publication retains the human-review notice when AI reports no findings", (t) => {
  for (const [metadata, notice] of [
    [{ dependency_review: { unclassified: 2 } }, /2 dependency change records remain unclassified/u],
    [
      { review_warnings: [{ kind: "prompt-injection", signals: ["instruction-override"] }] },
      /Potential prompt-injection instructions/u
    ],
    [
      { submodule_changes: [{ path: "lib/sub", before: "a".repeat(40), after: "b".repeat(40) }] },
      /1 submodule path changes require human review/u
    ]
  ]) {
    const result = { status: "complete", head_sha: headSha, findings: [], ...metadata };
    const fixture = runPublication({ comments: "101\n", result, comment: renderComment(result) });
    t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
    assert.equal(fixture.processResult.status, 0, fixture.processResult.stderr);
    assert.ok(fixture.calls.some((call) => call.includes("PATCH")));
    assert.ok(!fixture.calls.some((call) => call.includes("DELETE")));
    const payload = JSON.parse(
      readFileSync(path.join(fixture.temporaryRoot, "ai-security-review-comment.json"), "utf8")
    );
    assert.match(payload.body, notice);
  }
});

test("publication preserves findings and blocking policy near the byte limit", (t) => {
  const result = {
    status: "complete",
    fail_on_findings: true,
    head_sha: headSha,
    findings: validateCandidateOutput(commentBoundaryOutput(), batch)
  };
  const comment = renderComment(result);
  const fixture = runPublication({ result, comment });
  t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
  assert.equal(fixture.processResult.status, 0, fixture.processResult.stderr);
  const listComments = fixture.calls.find((call) => call.includes("--paginate"));
  assert.ok(listComments.at(-1).includes(comment.split("\n")[0]));
  const payload = JSON.parse(readFileSync(path.join(fixture.temporaryRoot, "ai-security-review-comment.json"), "utf8"));
  assert.equal(payload.body, comment);
  assert.match(payload.body, /HIGH or MEDIUM findings fail the workflow/u);
  assert.ok(Buffer.byteLength(payload.body, "utf8") <= 60_000);
});

test("publication independently rejects oversized and incorrectly marked artifacts", (t) => {
  for (const [comment, message] of [
    [`<!-- matter-labs-ai-security-review -->\n${"😀".repeat(15_000)}`, /exceeds 60000 bytes/u],
    ["## Wrong marker\n", /invalid marker/u]
  ]) {
    const fixture = runPublication({ result: { status: "complete", head_sha: headSha, findings: [{}] }, comment });
    t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
    assert.notEqual(fixture.processResult.status, 0);
    assert.match(fixture.processResult.stderr.toString(), message);
    assert.ok(
      !fixture.calls.some((call) => call.includes("POST") || call.includes("PATCH") || call.includes("DELETE"))
    );
  }
});

test("publication posts a failing status when the result artifact is missing", () => {
  const fixture = runPublication({});
  try {
    assert.notEqual(fixture.processResult.status, 0);
    assert.ok(fixture.calls.some((call) => call.includes("POST")));
    const payload = JSON.parse(
      readFileSync(path.join(fixture.temporaryRoot, "ai-security-review-comment.json"), "utf8")
    );
    assert.match(payload.body, /did not completely analyze commit `aaaaaaa`/u);
    assert.match(payload.body, /does not represent a clean security result/u);
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("publication does not overwrite the current comment from a stale run", () => {
  const result = { status: "complete", head_sha: headSha, findings: validateCandidateOutput(candidateOutput(), batch) };
  const fixture = runPublication({
    comments: "101\n",
    result,
    comment: renderComment(result)
  });
  try {
    const processResult = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_COMMENTS: "101\n",
        FAKE_GH_HEAD: "b".repeat(40),
        FAKE_GH_LOG: path.join(fixture.temporaryRoot, "stale-gh-calls.jsonl"),
        GH_TOKEN: "test-token",
        HEAD_SHA: headSha,
        PATH: `${path.join(fixture.temporaryRoot, "bin")}:${process.env.PATH}`,
        PR_NUMBER: "42",
        REPOSITORY: "matter-labs/fixture",
        RESULT_DIRECTORY: path.join(fixture.temporaryRoot, "result"),
        RUNNER_TEMP: fixture.temporaryRoot,
        RUN_URL: "https://github.com/matter-labs/fixture/actions/runs/1"
      }
    });
    assert.equal(processResult.status, 0, processResult.stderr);
    const calls = readFileSync(path.join(fixture.temporaryRoot, "stale-gh-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("repos/matter-labs/fixture/pulls/42"));
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("publication rejects unredacted or inconsistent comment artifacts before any mutation", (t) => {
  const result = { status: "complete", head_sha: headSha, findings: validateCandidateOutput(candidateOutput(), batch) };
  const secret = `glpat-${"a".repeat(20)}`;
  for (const extra of [secret, "Extra unvalidated text"]) {
    const fixture = runPublication({ comments: "101\n102\n", result, comment: `${renderComment(result)}${extra}\n` });
    t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
    assert.notEqual(fixture.processResult.status, 0);
    assert.match(fixture.processResult.stderr, /does not match the safely rendered result/u);
    assert.ok(!fixture.processResult.stderr.includes(secret));
    assert.ok(
      !fixture.calls.some((call) => call.includes("POST") || call.includes("PATCH") || call.includes("DELETE"))
    );
  }
});

test("publication applies the floor independently of candidate validation", (t) => {
  const secret = "postgresql://fixture:fake-pass@db.example/app";
  const result = {
    status: "complete",
    head_sha: headSha,
    findings: [{ ...candidateOutput({ description: secret }).findings[0], fingerprint: "ab".repeat(8) }]
  };
  const comment = renderComment(result);
  assert.doesNotMatch(comment, /fake-pass/u);
  const fixture = runPublication({ result, comment });
  t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
  assert.equal(fixture.processResult.status, 0, fixture.processResult.stderr);
  const payload = readFileSync(path.join(fixture.temporaryRoot, "ai-security-review-comment.json"), "utf8");
  assert.doesNotMatch(payload, /fake-pass/u);
});

test("validation through outgoing publication preserves identifiers and never quotes recognized secrets", (t) => {
  const token = `ghp_${"a".repeat(24)}`;
  const file = `src/${token}/${"ab".repeat(32)}.ts`;
  const address = `0x${"ab".repeat(20)}`;
  const pathBatch = { ...batch, units: [{ ...batch.units[0], path: file }] };
  const candidates = validateCandidateOutput(
    candidateOutput({
      file,
      title: `Credential exposure for ${address}`,
      evidence: "postgresql://fixture:fake-pass@db.example/app",
      description: `glpat-${"b".repeat(20)}`,
      attack_scenario: `Authorization: Bearer ${"c".repeat(24)}`,
      impact: `npm_${"d".repeat(36)}`,
      remediation: `-----BEGIN PRIVATE KEY-----\n${"e".repeat(100)}`
    }),
    pathBatch
  );
  assert.equal(candidates[0].file, file);
  const verdicts = validateVerdictOutput(
    {
      verdicts: [
        {
          fingerprint: candidates[0].fingerprint,
          verdict: "CONFIRMED",
          confidence: "HIGH",
          reason: `mnemonic: ${"word ".repeat(12)}`
        }
      ]
    },
    candidates
  );
  const result = buildFinalResult(
    {
      repository: "matter-labs/fixture",
      baseSha: "b".repeat(40),
      headSha,
      units: pathBatch.units,
      eligibleFiles: [file],
      skippedFiles: []
    },
    mergeCandidateLists([candidates]),
    verdicts
  );
  const fixture = runPublication({ result, comment: renderComment(result) });
  t.after(() => rmSync(fixture.temporaryRoot, { recursive: true, force: true }));
  assert.equal(fixture.processResult.status, 0, fixture.processResult.stderr);
  const { body } = JSON.parse(
    readFileSync(path.join(fixture.temporaryRoot, "ai-security-review-comment.json"), "utf8")
  );
  for (const secret of [
    token,
    "fake-pass",
    "b".repeat(20),
    "c".repeat(24),
    "d".repeat(36),
    "e".repeat(100),
    "word word"
  ]) {
    assert.ok(!body.includes(secret));
  }
  assert.ok(body.includes(address));
  assert.ok(body.includes("ab".repeat(32)));
  assert.ok(body.includes(candidates[0].fingerprint));
  assert.equal(result.findings[0].file, file);
});
