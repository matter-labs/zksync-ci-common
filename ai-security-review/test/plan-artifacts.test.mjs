import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

test("only the generated-plan upload includes hidden files", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../../.github/workflows/ai-security-review.yaml", import.meta.url), "utf8")
  );
  const uploads = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const planUploads = uploads.filter((step) => step.with?.name === `ai-security-review-plan-\${{ github.run_id }}`);
  assert.equal(planUploads.length, 1);
  const [planUpload] = planUploads;
  assert.equal(planUpload.with.path, `\${{ runner.temp }}/ai-security-review-plan`);
  assert.equal(planUpload.with["include-hidden-files"], true);
  assert.deepEqual(
    uploads.filter((step) => step.with?.["include-hidden-files"] === true),
    [planUpload]
  );
});
