import { booleanEnvironment, requiredEnvironment } from "./script-utils.mjs";

const eventName = requiredEnvironment("EVENT_NAME");
const isInternal = requiredEnvironment("IS_INTERNAL");

if (isInternal !== "true") {
  throw new Error("External fork pull requests must be moved to an internal branch before security review.");
}

const hasBatches = requiredEnvironment("HAS_BATCHES");
const prepareCliResult = requiredEnvironment("PREPARE_CLI_RESULT");
const prepareResult = requiredEnvironment("PREPARE_RESULT");
const publishResult = requiredEnvironment("PUBLISH_RESULT");
const reviewResult = requiredEnvironment("REVIEW_RESULT");
const verifyResult = requiredEnvironment("VERIFY_RESULT");
if (prepareCliResult !== "success" || prepareResult !== "success" || verifyResult !== "success") {
  throw new Error("AI security review did not complete.");
}
if (hasBatches === "true" && reviewResult !== "success") {
  throw new Error("AI security review batches did not complete.");
}
if (hasBatches === "false" && reviewResult !== "skipped") {
  throw new Error("AI security review produced an unexpected review-job result for an empty plan.");
}
if (eventName === "pull_request" && publishResult !== "success") {
  throw new Error("AI security review result was not published.");
}
if (eventName === "merge_group" && publishResult !== "skipped") {
  throw new Error("Merge-group review unexpectedly attempted pull request publication.");
}
if (!["pull_request", "merge_group"].includes(eventName)) {
  throw new Error(`unsupported completion event: ${eventName}`);
}

if (booleanEnvironment("FAIL_ON_FINDINGS")) {
  const rawFindingCount = requiredEnvironment("FINDING_COUNT");
  const findingCount = Number(rawFindingCount);
  if (!Number.isSafeInteger(findingCount) || findingCount < 0 || String(findingCount) !== rawFindingCount) {
    throw new Error("FINDING_COUNT must be a non-negative integer");
  }
  if (findingCount > 0) {
    throw new Error(`AI security review has ${findingCount} verified findings; fail_on_findings is enabled.`);
  }
}

console.log("AI security review completed.");
