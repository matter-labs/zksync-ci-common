import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/assert-complete.mjs", import.meta.url));
const successfulPullRequest = {
  EVENT_NAME: "pull_request",
  FAIL_ON_FINDINGS: "false",
  FINDING_COUNT: "0",
  HAS_BATCHES: "true",
  IS_INTERNAL: "true",
  PREPARE_CLI_RESULT: "success",
  PREPARE_RESULT: "success",
  PUBLISH_RESULT: "success",
  REVIEW_RESULT: "success",
  VERIFY_RESULT: "success"
};

function complete(overrides = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ...successfulPullRequest, ...overrides }
  });
}

test("completion accepts only fully successful pull request and merge-group paths", () => {
  assert.equal(complete().status, 0);
  assert.equal(complete({ HAS_BATCHES: "false", REVIEW_RESULT: "skipped" }).status, 0);
  assert.equal(complete({ EVENT_NAME: "merge_group", PUBLISH_RESULT: "skipped" }).status, 0);
});

test("completion rejects forks, cancellation, skipped work, and publication failures", () => {
  for (const overrides of [
    { IS_INTERNAL: "false" },
    { PREPARE_CLI_RESULT: "cancelled" },
    { PREPARE_RESULT: "skipped" },
    { REVIEW_RESULT: "cancelled" },
    { REVIEW_RESULT: "skipped" },
    { VERIFY_RESULT: "skipped" },
    { PUBLISH_RESULT: "failure" }
  ]) {
    assert.notEqual(complete(overrides).status, 0, JSON.stringify(overrides));
  }
});

test("finding enforcement is opt-in and runs after successful review and publication", () => {
  for (const event of [{}, { EVENT_NAME: "merge_group", PUBLISH_RESULT: "skipped" }]) {
    assert.equal(complete({ ...event, FINDING_COUNT: "2" }).status, 0);
    assert.equal(complete({ ...event, FAIL_ON_FINDINGS: "true", FINDING_COUNT: "0" }).status, 0);
    const blocked = complete({ ...event, FAIL_ON_FINDINGS: "true", FINDING_COUNT: "2" });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /2 verified findings; fail_on_findings is enabled/u);
  }
  const unpublished = complete({ FAIL_ON_FINDINGS: "true", FINDING_COUNT: "2", PUBLISH_RESULT: "failure" });
  assert.match(unpublished.stderr, /result was not published/u);
});

test("finding enforcement fails closed on a missing or malformed count and invalid policy", () => {
  for (const count of ["", "-1", "NaN", "Infinity", "0.5", "0junk", " 0", "00", "1e0", "9007199254740992"]) {
    const result = complete({ FAIL_ON_FINDINGS: "true", FINDING_COUNT: count });
    assert.notEqual(result.status, 0, count);
    assert.match(result.stderr, /FINDING_COUNT/u);
  }
  assert.notEqual(complete({ FAIL_ON_FINDINGS: "yes" }).status, 0);
});
