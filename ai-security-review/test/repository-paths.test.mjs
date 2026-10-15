import assert from "node:assert/strict";
import test from "node:test";
import { eligibilityForPath, isKnownBinaryPath, isLockfilePath } from "../scripts/repository-paths.mjs";

test("eligibility reviews every safe textual path", () => {
  assert.deepEqual(eligibilityForPath("docs/guide.md"), { eligible: true });
  assert.deepEqual(eligibilityForPath("package-lock.json"), { eligible: true });
  assert.deepEqual(eligibilityForPath("target/release/server"), { eligible: true });
  assert.deepEqual(eligibilityForPath("src/server.ts"), { eligible: true });
  assert.deepEqual(eligibilityForPath(".github/workflows/ci.yaml"), { eligible: true });
  assert.deepEqual(eligibilityForPath(".github/security-review-focus.md"), { eligible: true });
  assert.deepEqual(eligibilityForPath("src/vendor/runtime.ts"), { eligible: true });
  assert.deepEqual(eligibilityForPath("vendor/runtime.ts"), { eligible: true });
  assert.deepEqual(eligibilityForPath("docs/private-threat-model.md", { forceReview: true }), { eligible: true });
  assert.deepEqual(eligibilityForPath(":(literal)src/auth.ts"), { eligible: true });
  assert.deepEqual(eligibilityForPath("src/control\nname.ts"), { eligible: false, reason: "unsafe-path" });
  assert.equal(isKnownBinaryPath("assets/logo.png"), true);
  assert.equal(isKnownBinaryPath("assets/data.dat"), false);
  assert.equal(isLockfilePath("nested/package-lock.json"), true);
});
