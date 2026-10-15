import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertClaudeRuntime } from "./claude-runtime-check.mjs";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(`The pinned Claude CLI smoke test requires Linux x64; received ${process.platform} ${process.arch}.`);
}

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ai-security-review.yaml", import.meta.url));

function readWorkflowEnvironment(workflow, name) {
  const prefix = `${name}:`;
  const line = workflow.split("\n").find((candidate) => candidate.trimStart().startsWith(prefix));
  if (!line) {
    throw new Error(`Missing ${name} in ${workflowPath}`);
  }
  const value = line.trimStart().slice(prefix.length).trim();
  if (!value) {
    throw new Error(`Missing ${name} in ${workflowPath}`);
  }
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
}

const workflow = readFileSync(workflowPath, "utf8");
const integrity = readWorkflowEnvironment(workflow, "CLAUDE_CLI_INTEGRITY");
const url = readWorkflowEnvironment(workflow, "CLAUDE_CLI_URL");
const version = readWorkflowEnvironment(workflow, "CLAUDE_CLI_VERSION");
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "claude-cli-smoke-test-"));

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Failed to download Claude CLI: HTTP ${response.status}`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (actualIntegrity !== integrity) {
    throw new Error(`Claude CLI integrity mismatch: ${actualIntegrity}`);
  }

  const archivePath = path.join(temporaryDirectory, "claude-code.tgz");
  const extractionDirectory = path.join(temporaryDirectory, "extracted");
  writeFileSync(archivePath, archive);
  mkdirSync(extractionDirectory);
  execFileSync("tar", ["-xzf", archivePath, "-C", extractionDirectory], { stdio: "inherit" });

  const executable = path.join(extractionDirectory, "package", "claude");
  accessSync(executable, constants.X_OK);
  const actualVersion = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  if (actualVersion !== `${version} (Claude Code)`) {
    throw new Error(`Unexpected Claude CLI version: ${actualVersion}`);
  }
  execFileSync(executable, ["--help"], { stdio: "ignore" });
  console.log(`Verified Claude Code ${version} native executable.`);
  await assertClaudeRuntime(executable);
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
