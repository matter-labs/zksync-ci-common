import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { diagnosticFile, sessionFailure, sessionMetrics } from "./review-diagnostics.mjs";
import { requiredEnvironment } from "./script-utils.mjs";

const directory = requiredEnvironment("DIAGNOSTICS_DIRECTORY");
const stage = requiredEnvironment("STAGE");
const file = diagnosticFile(directory, stage, process.env.BATCH_ID);
const diagnostic = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {
      schema_version: 1,
      stage,
      batch_id: process.env.BATCH_ID ?? null,
      outcome: "failure",
      failure: { code: "session-or-validation-incomplete" },
      session: {}
    };
try {
  const messages = JSON.parse(readFileSync(process.env.EXECUTION_FILE, "utf8"));
  diagnostic.session = sessionMetrics(messages);
  const failure = sessionFailure(messages);
  if (failure && ["session-or-validation-incomplete", "validation-failed"].includes(diagnostic.failure?.code)) {
    diagnostic.failure = failure;
    console.log(
      `Claude session failure category: ${failure.code}${failure.http_status ? ` (HTTP ${failure.http_status})` : ""}${failure.reason ? `: ${failure.reason}` : ""}.`
    );
  }
} catch {
  // Failed sessions may not produce an execution file.
}
const modelOutcome = process.env.MODEL_OUTCOME;
diagnostic.model_outcome = ["success", "failure", "skipped", "cancelled"].includes(modelOutcome)
  ? modelOutcome
  : "unknown";
mkdirSync(directory, { recursive: true });
writeFileSync(file, JSON.stringify(diagnostic, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### Security ${stage}${diagnostic.batch_id ? ` ${diagnostic.batch_id}` : ""}`,
      `Model execution: ${diagnostic.model_outcome}. Validation: ${diagnostic.outcome}.`,
      `Turns: ${diagnostic.session.num_turns ?? "unavailable"}. Reported cost: ${diagnostic.session.total_cost_usd === undefined ? "unavailable" : `$${diagnostic.session.total_cost_usd.toFixed(4)}`}.`,
      diagnostic.failure
        ? `Review incomplete (${diagnostic.failure.code}). See the sanitized diagnostics artifact for details.`
        : "Validated result saved.",
      ""
    ].join("\n") + "\n"
  );
}
