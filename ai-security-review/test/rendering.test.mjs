import assert from "node:assert/strict";
import test from "node:test";
import { Parser } from "commonmark";
import { renderPlanPrompt, renderComment } from "../scripts/rendering.mjs";
import { validateCandidateOutput } from "../scripts/review-results.mjs";
import { batch, candidateOutput, commentBoundaryOutput } from "./candidate-fixture.mjs";

test("unclassified dependency changes produce a neutral notice even without AI findings", () => {
  assert.match(
    renderComment({ findings: [], dependency_review: { unclassified: 0 } }),
    /No reportable security findings/u
  );
  const comment = renderComment({ findings: [], dependency_review: { unclassified: 3 } });
  assert.match(comment, /3 dependency change records remain unclassified/u);
  assert.match(comment, /not source approval/u);
  assert.match(comment, /Human review is required/u);
  assert.doesNotMatch(comment, /### HIGH|### MEDIUM/u);
  const findings = validateCandidateOutput(commentBoundaryOutput(), batch);
  const combined = renderComment({ findings, dependency_review: { unclassified: 3 } });
  assert.ok(Buffer.byteLength(combined, "utf8") <= 60_000);
  assert.match(combined, /remain unclassified/u);
  assert.match(combined, /additional verified finding/u);
});

test("comment rendering neutralizes mentions and markup", () => {
  const [candidate] = validateCandidateOutput(
    candidateOutput({ title: "Notify @security <script>", description: "unsafe\nheading" }),
    batch
  );
  const comment = renderComment({ findings: [{ ...candidate, verification: { reason: "confirmed" } }] });
  assert.doesNotMatch(comment, /@security/u);
  assert.doesNotMatch(comment, /<script>/u);
  assert.match(comment, /unsafe heading/u);
});

test("rendering sanitizes every public string without mutating canonical fields", () => {
  const secret = `github_pat_${"a".repeat(24)}_${"b".repeat(24)}`;
  const [candidate] = validateCandidateOutput(candidateOutput(), batch);
  const findings = [{ ...candidate, file: `src/${secret}.ts`, fingerprint: secret }];
  const comment = renderComment({ findings });
  assert.ok(!comment.includes(secret));
  assert.equal(findings[0].file, `src/${secret}.ts`);
  assert.equal(findings[0].fingerprint, secret);
  for (const override of [{ severity: secret }, { line: secret }]) {
    assert.throws(
      () => renderComment({ findings: [{ ...candidate, ...override }] }),
      (error) => !error.message.includes(secret)
    );
  }
  assert.throws(
    () => renderComment({ findings, dependency_review: { unclassified: secret } }),
    /invalid unclassified/u
  );
  assert.throws(() => renderComment({ findings, skipped_files: { length: secret } }), /metadata/u);
});

test("comment rendering stays below the GitHub size limit and reports overflow", () => {
  const [candidate] = validateCandidateOutput(
    candidateOutput({
      evidence: "e ".repeat(600),
      description: "d ".repeat(1000),
      attack_scenario: "a ".repeat(800),
      impact: "i ".repeat(600),
      remediation: "r ".repeat(600)
    }),
    batch
  );
  const findings = Array.from({ length: 50 }, (_, index) => ({
    ...candidate,
    fingerprint: String(index).padStart(16, "0"),
    file: `src/file-${index}.ts`
  }));
  const comment = renderComment({ findings });
  assert.ok(Buffer.byteLength(comment, "utf8") <= 60_000);
  assert.match(comment, /additional verified findings are available in the workflow artifact/u);
});

test("comment size includes the complete footer at the publication boundary", () => {
  const findings = validateCandidateOutput(commentBoundaryOutput(), batch);
  for (const fail_on_findings of [false, true]) {
    const comment = renderComment({ findings, head_sha: "a".repeat(40), fail_on_findings });
    assert.ok(Buffer.byteLength(comment, "utf8") <= 60_000);
    assert.match(comment, /1 additional verified finding is available/u);
    assert.match(comment, /incomplete reviews (also )?fail the workflow\.\n$/u);
    assert.ok(comment.includes("findings are advisory") === !fail_on_findings);
    assert.ok(comment.includes("HIGH or MEDIUM findings fail") === fail_on_findings);
  }
  assert.throws(() => renderComment({ findings: [], fail_on_findings: "false" }), /invalid finding policy/u);
});

test("comment size accounts for Unicode and escaped markup without truncating findings", () => {
  for (const text of ["😀 ".repeat(300), "@".repeat(1200)]) {
    const [candidate] = validateCandidateOutput(
      candidateOutput({
        evidence: text,
        description: text,
        attack_scenario: text,
        impact: text,
        remediation: text
      }),
      batch
    );
    const findings = Array.from({ length: 50 }, (_, index) => ({
      ...candidate,
      fingerprint: String(index).padStart(16, "0")
    }));
    const comment = renderComment({ findings });
    assert.ok(Buffer.byteLength(comment, "utf8") <= 60_000);
    assert.match(comment, /additional verified findings are available/u);
    assert.equal(comment.split("### HIGH:").length, comment.split("**Suggested remediation:**").length);
  }
});

test("plan prompts render relative to the runtime plan directory", () => {
  const rendered = renderPlanPrompt(
    "Read {{PLAN_ROOT}}/units/unit-0001.patch and {{PLAN_ROOT}}/changed-files.json",
    "/runner/plan",
    "/runner/source"
  );
  assert.match(rendered, /Source checkout \(untrusted\): "\/runner\/source"/u);
  assert.ok(rendered.endsWith("Read /runner/plan/units/unit-0001.patch and /runner/plan/changed-files.json"));
  assert.throws(() => renderPlanPrompt("x", "relative/plan", "/runner/source"), /absolute/u);
  assert.throws(() => renderPlanPrompt("x", "/runner/plan", "relative/source"), /absolute/u);
});

test("comment rendering breaks autolinked URLs", () => {
  const [candidate] = validateCandidateOutput(
    candidateOutput({ title: "Visit https://evil.example/p?sk=1 or www.evil.example now" }),
    batch
  );
  const comment = renderComment({ findings: [{ ...candidate, verification: { reason: "confirmed" } }] });
  assert.doesNotMatch(comment, /https:\/\/evil/u);
  assert.doesNotMatch(comment, /www\.evil/u);
  assert.match(comment, /https:&#8203;\/&#8203;\/evil\.example/u);
});

test("untrusted comment fields cannot introduce Markdown links or images", () => {
  const [candidate] = validateCandidateOutput(candidateOutput(), batch);
  const runUrl = "https://github.com/example/repo/actions/runs/123";
  const payloads = [
    String.raw`\[x\](//evil.example/path)`,
    String.raw`\[x\](/relative)`,
    String.raw`\![x\](//evil.example/image)`,
    "[x](//evil.example/path)",
    "<https://evil.example/path>",
    "<a href='//evil.example'>link</a>",
    "&#91;x&#93;(//evil.example/path)",
    "`[x](//evil.example/path)`",
    ...Array.from({ length: 8 }, (_, index) => "\\".repeat(index) + "[x](//evil.example/path)")
  ];
  for (const field of [
    "title",
    "file",
    "fingerprint",
    "description",
    "evidence",
    "attack_scenario",
    "impact",
    "remediation"
  ]) {
    for (const payload of payloads) {
      const comment = renderComment({ findings: [{ ...candidate, [field]: payload }], run_url: runUrl });
      const walker = new Parser().parse(comment).walker();
      const destinations = [];
      for (let event; (event = walker.next()); ) {
        if (!event.entering) continue;
        if (["link", "image"].includes(event.node.type)) destinations.push(event.node.destination);
        if (event.node.type === "html_inline") assert.ok(!event.node.literal.includes("evil.example"));
      }
      assert.deepEqual(destinations, [runUrl], `${field}: ${payload}`);
    }
  }
});

test("finding order is independent of ICU and retains severity and numeric line priorities", () => {
  const [candidate] = validateCandidateOutput(candidateOutput(), batch);
  const findings = [
    { ...candidate, file: "src/\u044f.ts", line: 10, title: "Third" },
    { ...candidate, file: "src/\u1c89.ts", line: 1, title: "Fourth" },
    { ...candidate, file: "src/\u044f.ts", line: 2, title: "Second" },
    { ...candidate, file: "src/a.ts", severity: "MEDIUM", title: "Fifth" },
    { ...candidate, file: "src/a.ts", title: "First" }
  ];
  const titles = [...renderComment({ findings }).matchAll(/^### (?:HIGH|MEDIUM): (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(titles, ["First", "Second", "Third", "Fourth", "Fifth"]);
});
