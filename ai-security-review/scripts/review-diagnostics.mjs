import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export class ReviewValidationError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

export function sessionMetrics(messages) {
  const result = messages.findLast((entry) => entry?.type === "result");
  return Object.fromEntries(
    ["num_turns", "total_cost_usd", "duration_ms"].flatMap((field) => {
      const value = result?.[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [[field, value]] : [];
    })
  );
}

const API_FAILURES = new Map([
  [400, "api-invalid-request"],
  [401, "api-authentication"],
  [402, "api-billing"],
  [403, "api-permission"],
  [404, "api-not-found"],
  [408, "api-timeout"],
  [413, "api-request-too-large"],
  [429, "api-rate-limit"],
  [500, "api-server-error"],
  [502, "api-server-error"],
  [503, "api-unavailable"],
  [504, "api-timeout"],
  [529, "api-overloaded"]
]);

const ASSISTANT_FAILURES = new Map([
  ["authentication_failed", "api-authentication"],
  ["billing_error", "api-billing"],
  ["rate_limit", "api-rate-limit"],
  ["invalid_request", "api-invalid-request"],
  ["server_error", "api-server-error"]
]);

const SESSION_LIMITS = new Map([
  ["error_max_turns", "session-turn-limit"],
  ["error_max_budget_usd", "session-budget-limit"],
  ["error_max_structured_output_retries", "structured-output-retry-limit"]
]);

export function sessionFailure(messages) {
  const result = messages.findLast((entry) => entry?.type === "result");
  if (!result) return { code: "session-result-missing" };
  if (result.subtype === "success" && result.is_error === false) {
    return result.structured_output ? null : { code: "structured-output-missing" };
  }
  if (SESSION_LIMITS.has(result.subtype)) return { code: SESSION_LIMITS.get(result.subtype) };

  // Never retain arbitrary text from these bounded error prefixes.
  const errors = [result.result, ...(Array.isArray(result.errors) ? result.errors.slice(0, 8) : [])];
  for (const error of errors) {
    if (typeof error !== "string") continue;
    const prefix = error.slice(0, 2048);
    const status = Number(/^API Error: (\d{3})(?:\s|$)/u.exec(prefix.slice(0, 64))?.[1]);
    if (API_FAILURES.has(status)) {
      const failure = { code: API_FAILURES.get(status), http_status: status };
      const field = /^API Error: 400 (tools\.\d{1,2}\.custom\.input_schema):/u.exec(prefix.slice(0, 64))?.[1];
      if (field) failure.field = field;
      if (status === 400 && prefix.includes("input_schema does not support oneOf, allOf, or anyOf at the top level")) {
        failure.reason = "unsupported-root-schema-combinator";
      }
      return failure;
    }
  }
  const assistant = messages.findLast((entry) => entry?.type === "assistant");
  if (ASSISTANT_FAILURES.has(assistant?.error)) return { code: ASSISTANT_FAILURES.get(assistant.error) };
  return { code: "session-execution-error" };
}

export function diagnosticFile(directory, stage, batchId) {
  if (!["reviewer", "verifier"].includes(stage)) throw new Error("invalid diagnostic stage");
  if (stage === "reviewer" && !/^batch-\d+$/u.test(batchId)) throw new Error("invalid diagnostic batch");
  return path.join(directory, `${stage === "reviewer" ? batchId : stage}.json`);
}

export function withValidationDiagnostics(stage, callback) {
  let failure;
  try {
    return callback();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const directory = process.env.DIAGNOSTICS_DIRECTORY;
    if (directory) {
      let metrics = {};
      try {
        metrics = sessionMetrics(JSON.parse(readFileSync(process.env.EXECUTION_FILE, "utf8")));
      } catch {
        /* No usable execution output. */
      }
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        diagnosticFile(directory, stage, process.env.BATCH_ID),
        JSON.stringify(
          {
            schema_version: 1,
            stage,
            batch_id: process.env.BATCH_ID ?? null,
            outcome: failure ? "failure" : "success",
            session: metrics,
            failure:
              failure instanceof ReviewValidationError
                ? failure.diagnostics
                : failure
                  ? { code: "validation-failed" }
                  : null
          },
          null,
          2
        ) + "\n"
      );
    }
  }
}
