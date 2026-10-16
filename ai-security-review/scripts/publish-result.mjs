import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertCommentBody, COMMENT_MARKER, MAX_COMMENT_BYTES } from "./comment-contract.mjs";
import { renderComment } from "./rendering.mjs";
import { requiredEnvironment } from "./script-utils.mjs";

const headSha = requiredEnvironment("HEAD_SHA");
const prNumber = requiredEnvironment("PR_NUMBER");
const repository = requiredEnvironment("REPOSITORY");
const resultDirectory = path.resolve(requiredEnvironment("RESULT_DIRECTORY"));
const runUrl = requiredEnvironment("RUN_URL");
const runnerTemp = path.resolve(requiredEnvironment("RUNNER_TEMP"));

if (!/^[a-f0-9]{40,64}$/u.test(headSha)) throw new Error("HEAD_SHA must be a full commit hash");
if (!/^\d+$/u.test(prNumber)) throw new Error("PR_NUMBER must be numeric");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("REPOSITORY is invalid");

function gh(arguments_) {
  return execFileSync("gh", arguments_, { encoding: "utf8" }).trim();
}

const currentHeadSha = gh(["api", `repos/${repository}/pulls/${prNumber}`, "--jq", ".head.sha"]);
if (currentHeadSha !== headSha) {
  console.log(`Pull request advanced to ${currentHeadSha}; skipping publication for stale commit ${headSha}.`);
  process.exit(0);
}

const commentIds = gh([
  "api",
  "--paginate",
  `repos/${repository}/issues/${prNumber}/comments?per_page=100`,
  "--jq",
  `.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("${COMMENT_MARKER}"))) | .id`
])
  .split("\n")
  .filter(Boolean);
if (commentIds.some((id) => !/^\d+$/u.test(id))) throw new Error("GitHub returned an invalid comment ID");

const resultFile = path.join(resultDirectory, "result.json");
const commentFile = path.join(resultDirectory, "comment.md");
let result = null;
try {
  result = JSON.parse(readFileSync(resultFile, "utf8"));
} catch {
  result = null;
}

const validResult = result?.status === "complete" && result.head_sha === headSha && Array.isArray(result.findings);

let body;
let publishFailed;
if (validResult) {
  if (!existsSync(commentFile) || statSync(commentFile).size === 0) {
    throw new Error("The completed review comment artifact is empty.");
  }
  if (statSync(commentFile).size > MAX_COMMENT_BYTES)
    throw new Error(`Comment artifact exceeds ${MAX_COMMENT_BYTES} bytes.`);
  const suppliedBody = readFileSync(commentFile, "utf8");
  assertCommentBody(suppliedBody);
  body = renderComment(result);
  if (suppliedBody !== body) throw new Error("Comment artifact does not match the safely rendered result.");
  publishFailed = false;
} else {
  const shortSha = headSha.slice(0, 7);
  body = [
    COMMENT_MARKER,
    "## AI security review did not complete",
    "",
    `The review did not completely analyze commit \`${shortSha}\`.`,
    "This failure does not represent a clean security result.",
    "",
    `[Open the workflow run](${runUrl}).`,
    "",
    "Fix the reported failure, then re-run failed jobs while prerequisite artifacts remain available. If artifacts are missing or expired, re-run all jobs or push a new commit.",
    ""
  ].join("\n");
  publishFailed = true;
}

const payloadFile = path.join(runnerTemp, "ai-security-review-comment.json");
writeFileSync(payloadFile, JSON.stringify({ body }));
if (commentIds.length === 0) {
  gh(["api", "--method", "POST", `repos/${repository}/issues/${prNumber}/comments`, "--input", payloadFile]);
} else {
  gh(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${commentIds[0]}`, "--input", payloadFile]);
  for (const commentId of commentIds.slice(1)) {
    gh(["api", "--method", "DELETE", `repos/${repository}/issues/comments/${commentId}`]);
  }
}

if (publishFailed) throw new Error("AI security review did not complete; published a failure comment.");
