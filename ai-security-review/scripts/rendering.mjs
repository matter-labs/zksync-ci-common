import path from "node:path";
import { assert } from "./assert.mjs";
import { assertCommentBody, COMMENT_MARKER, MAX_COMMENT_BYTES } from "./comment-contract.mjs";
import { redactSecretMaterial } from "./redaction.mjs";

export const PLAN_ROOT_TOKEN = "{{PLAN_ROOT}}";

export function renderPlanPrompt(template, planDirectory, sourceDirectory) {
  assert(typeof template === "string", "prompt template must be a string");
  assert(path.isAbsolute(planDirectory), "plan directory must be absolute");
  assert(path.isAbsolute(sourceDirectory), "source directory must be absolute");
  return [
    `Source checkout (untrusted): ${JSON.stringify(sourceDirectory)}. Resolve repository paths against this directory, not the session working directory.`,
    template.replaceAll(PLAN_ROOT_TOKEN, planDirectory)
  ].join("\n\n");
}

function safeMarkdownText(value) {
  return redactSecretMaterial(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/@/gu, "@&#8203;")
    .replace(/:\/\//gu, ":&#8203;//")
    .replace(/\bwww\./giu, "www&#8203;.")
    .replace(/[`[\]]/gu, "\\$&")
    .replace(/\s+/gu, " ")
    .trim();
}

function commentFooter(omittedFindings, failOnFindings) {
  return [
    ...(omittedFindings > 0
      ? [
          `${omittedFindings} additional verified ${omittedFindings === 1 ? "finding is" : "findings are"} available in the workflow artifact.`,
          ""
        ]
      : []),
    failOnFindings
      ? "Policy: verified HIGH or MEDIUM findings fail the workflow. Source-policy violations and incomplete reviews also fail the workflow."
      : "Policy: verified findings are advisory. Source-policy violations and incomplete reviews fail the workflow.",
    ""
  ];
}

export function renderComment(result) {
  assert(Array.isArray(result.findings), "comment findings must be an array");
  assert(
    result.fail_on_findings === undefined || typeof result.fail_on_findings === "boolean",
    "invalid finding policy"
  );
  const unclassified = result.dependency_review?.unclassified ?? 0;
  assert(Number.isSafeInteger(unclassified) && unclassified >= 0, "invalid unclassified dependency count");
  for (const field of ["skipped_files", "lockfile_source_changes"]) {
    assert(result[field] === undefined || Array.isArray(result[field]), "comment metadata must contain arrays");
  }
  const warnings = result.review_warnings ?? [];
  const submodules = result.submodule_changes ?? [];
  assert(Array.isArray(warnings) && Array.isArray(submodules), "invalid review warnings");
  let runLink = null;
  if (result.run_url !== undefined) {
    assert(
      typeof result.run_url === "string" &&
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/u.test(result.run_url),
      "invalid workflow run URL"
    );
    runLink = `[Workflow run](${result.run_url}).`;
  }

  const lines = [
    COMMENT_MARKER,
    "## AI security review",
    "",
    result.findings.length
      ? `Found ${result.findings.length} high-confidence security ${result.findings.length === 1 ? "finding" : "findings"}.`
      : "No reportable security findings were identified. This is not a guarantee that the change is secure.",
    ...(result.head_sha ? [`Reviewed commit: \`${safeMarkdownText(result.head_sha.slice(0, 12))}\`.`] : []),
    ...(Array.isArray(result.eligible_files) && Array.isArray(result.reviewed_units)
      ? [`Reviewed ${result.eligible_files.length} files across ${result.reviewed_units.length} units.`]
      : []),
    ...(typeof result.verifier_ran === "boolean"
      ? [
          result.verifier_ran
            ? "Candidate verification ran."
            : "Candidate verification was skipped because no candidates required verification."
        ]
      : []),
    ...(warnings.length
      ? [
          `Potential prompt-injection instructions were detected in ${warnings.length} review input records. Human review is required.`,
          "This deterministic warning cannot be dismissed by the model. Benign repository content can also trigger it; see review_warnings in the result artifact."
        ]
      : []),
    ...(submodules.length
      ? [
          `${submodules.length} submodule path changes require human review. The review covers pointer changes, not the code at the referenced commits. See submodule_changes in the result artifact.`
        ]
      : []),
    ...(runLink ? [runLink] : []),
    ...(result.skipped_files?.length
      ? [`Verified binary assets excluded from model review: ${result.skipped_files.length}. See the result artifact.`]
      : []),
    ...(result.lockfile_source_changes?.length
      ? [
          `Recognized lockfile source changes checked: ${result.lockfile_source_changes.length}. See the result artifact.`
        ]
      : []),
    ...(unclassified > 0
      ? [
          `${unclassified} dependency change records remain unclassified by deterministic source checks. Their context was included in the completed AI review; this is not source approval.`,
          "Human review is required. See dependency_changes in the result artifact for evidence and coverage limitations."
        ]
      : []),
    ""
  ];

  const severityOrder = { HIGH: 0, MEDIUM: 1 };
  for (const finding of result.findings) {
    assert(finding && Object.hasOwn(severityOrder, finding.severity), "invalid publishable severity");
    assert(Number.isSafeInteger(finding.line) && finding.line >= 1, "invalid finding line");
    assert(typeof finding.file === "string", "finding file must be a string");
  }
  const orderedFindings = [...result.findings].sort((left, right) => {
    return (
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.file.localeCompare(right.file) ||
      left.line - right.line
    );
  });
  let renderedFindings = 0;
  for (const finding of orderedFindings) {
    const section = [
      `### ${finding.severity}: ${safeMarkdownText(finding.title)}`,
      "",
      `**Location:** \`${safeMarkdownText(finding.file)}:${finding.line}\` · \`${safeMarkdownText(finding.fingerprint)}\``,
      "",
      `**Why this is vulnerable:** ${safeMarkdownText(finding.description)}`,
      "",
      `**Evidence:** ${safeMarkdownText(finding.evidence)}`,
      "",
      `**Attack scenario:** ${safeMarkdownText(finding.attack_scenario)}`,
      "",
      `**Impact:** ${safeMarkdownText(finding.impact)}`,
      "",
      `**Suggested remediation:** ${safeMarkdownText(finding.remediation)}`,
      ""
    ];
    const remaining = result.findings.length - renderedFindings - 1;
    const projected = [...lines, ...section, ...commentFooter(remaining, result.fail_on_findings)].join("\n");
    if (Buffer.byteLength(projected, "utf8") > MAX_COMMENT_BYTES) {
      break;
    }
    lines.push(...section);
    renderedFindings += 1;
  }

  const comment = [...lines, ...commentFooter(result.findings.length - renderedFindings, result.fail_on_findings)].join(
    "\n"
  );
  assertCommentBody(comment);
  return comment;
}
