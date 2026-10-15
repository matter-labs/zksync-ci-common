export function candidateOutput(overrides = {}) {
  return {
    unit_reviews: [
      {
        unit_id: "unit-0001",
        status: "FINDING",
        summary: "The changed authorization branch is reachable.",
        evidence_line: 12
      }
    ],
    findings: [
      {
        unit_id: "unit-0001",
        file: "src/auth.ts",
        line: 12,
        severity: "HIGH",
        confidence: "HIGH",
        title: "Authorization check can be bypassed",
        evidence: "The changed branch returns before the permission decision.",
        description: "An authenticated user can skip the resource permission check.",
        attack_scenario: "A user sends a request with the new fast-path flag.",
        impact: "The user can read another organization's resource.",
        remediation: "Evaluate the permission before entering the fast path.",
        ...overrides
      }
    ]
  };
}

export const batch = {
  id: "batch-001",
  units: [{ id: "unit-0001", path: "src/auth.ts", changedLines: [12], profiles: ["universal"] }]
};

export function commentBoundaryOutput() {
  return {
    ...candidateOutput(),
    findings: Array.from(
      { length: 9 },
      (_, index) =>
        candidateOutput({
          title: `Finding ${index}`,
          evidence: "e ".repeat(600),
          description: "d ".repeat(630),
          attack_scenario: "a ".repeat(800),
          impact: "i ".repeat(600),
          remediation: "r ".repeat(600)
        }).findings[0]
    )
  };
}
