import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { changedLineRanges } from "./review-planning.mjs";
import { ReviewValidationError } from "./review-diagnostics.mjs";

export function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function integerEnvironment(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function booleanEnvironment(name) {
  const value = process.env[name] ?? "false";
  if (!["true", "false"].includes(value)) throw new Error(`${name} must be true or false`);
  return value === "true";
}

export function readExecutionOutput(executionFile, source) {
  let messages;
  try {
    messages = JSON.parse(readFileSync(executionFile, "utf8"));
  } catch (error) {
    throw new Error(`${source} execution output is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(messages)) throw new Error(`${source} execution output must be an array`);

  const results = messages.filter((message) => message?.type === "result");
  if (results.length !== 1) throw new Error(`${source} execution output must contain exactly one result`);
  if (results[0].subtype !== "success" || results[0].is_error !== false) {
    throw new Error(`${source} execution did not complete successfully`);
  }
  const structuredOutput = results[0].structured_output;
  if (!structuredOutput || typeof structuredOutput !== "object" || Array.isArray(structuredOutput)) {
    throw new Error(`${source} did not return structured output`);
  }
  return { messages, structuredOutput };
}

export function readStructuredOutput(executionFile, source) {
  return readExecutionOutput(executionFile, source).structuredOutput;
}

function successfulReadResults(messages) {
  const calls = new Map();
  const usedIds = new Set();
  const reads = [];
  for (const entry of messages) {
    if (entry?.type === "result") break;
    if (entry?.parent_tool_use_id != null || !Array.isArray(entry?.message?.content)) continue;
    for (const block of entry.message.content) {
      if (entry.type === "assistant" && entry.message.role === "assistant" && block.type === "tool_use") {
        if (typeof block.id !== "string" || !block.id || usedIds.has(block.id)) {
          throw new Error("review coverage: invalid or duplicate tool ID");
        }
        usedIds.add(block.id);
        calls.set(block.id, block);
      }
      if (entry.type !== "user" || entry.message.role !== "user" || block.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (!call) throw new Error("review coverage: result without a preceding tool call");
      calls.delete(block.tool_use_id);
      if (call.name !== "Read" || (block.is_error !== undefined && block.is_error !== false)) continue;
      const input = call.input;
      if (typeof input?.file_path !== "string" || !path.isAbsolute(input.file_path)) continue;
      if (
        ["offset", "limit"].some(
          (key) => input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] <= 0)
        )
      )
        continue;
      if (typeof block.content !== "string") continue;
      reads.push({ input, content: block.content });
    }
  }
  return reads;
}

function returnedPatchLines(read, expectedLines) {
  const lines = read.content.split("\n");
  if (lines.length > (read.input.limit ?? Infinity)) return [];
  const start = read.input.offset ?? 1;
  const indices = [];
  for (const [offset, line] of lines.entries()) {
    const index = start + offset;
    // The pinned CLI emits numbered text, normalizes CRLF, and includes a terminal empty line.
    if (index > expectedLines.length || line !== `${index}\t${expectedLines[index - 1]}`) return [];
    indices.push(index);
  }
  return indices;
}

export function assertPatchReadCoverage(messages, batch, planDirectory) {
  const reads = successfulReadResults(messages);
  for (const unit of batch.units) {
    const expectedPath = realpathSync(path.resolve(planDirectory, unit.patchFile));
    const content = readFileSync(expectedPath, "utf8");
    if (
      unit.kind === "dependency-context" &&
      createHash("sha256").update(content).digest("hex") !== unit.contentSha256
    ) {
      throw new Error(`dependency context integrity mismatch: ${unit.id}`);
    }
    const expectedLines = content.replaceAll("\r\n", "\n").split("\n");
    const covered = new Set();
    for (const read of reads) {
      let actualPath;
      try {
        actualPath = realpathSync(read.input.file_path);
      } catch {
        continue;
      }
      if (actualPath !== expectedPath) continue;
      for (const line of returnedPatchLines(read, expectedLines)) covered.add(line);
    }
    const requiredCount = expectedLines.length - (content.endsWith("\n") ? 1 : 0);
    const missing = Array.from({ length: requiredCount }, (_, index) => index + 1).filter((line) => !covered.has(line));
    if (missing.length) {
      const ranges = changedLineRanges(missing);
      throw new ReviewValidationError(
        `review coverage mismatch: ${unit.id} patch returned ${requiredCount - missing.length} of ${requiredCount} lines; missing ranges ${JSON.stringify(ranges)}`,
        { code: "incomplete-read", unit_id: unit.id, missing_ranges: ranges }
      );
    }
  }
}
