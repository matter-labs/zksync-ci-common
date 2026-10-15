import { readFileSync } from "node:fs";
import path from "node:path";

const SIGNALS = [
  [
    "instruction-override",
    /\b(?:ignore|disregard|override)\b[\s\S]{0,80}\b(?:previous|prior|system|developer)\b[\s\S]{0,40}\b(?:instructions?|prompts?)\b/iu
  ],
  ["forced-clean-output", /\b(?:return|output|emit|report)\s+(?:only|just)\s+["'`]?CLEAN\b/iu],
  ["forced-clean-units", /\b(?:mark|report)\s+(?:all|every)\s+(?:review\s+)?units?\b[\s\S]{0,40}\bCLEAN\b/iu],
  [
    "output-contract-override",
    /\b(?:override|replace|force|manipulate)\b[\s\S]{0,80}\b(?:unit_reviews|StructuredOutput)\b/iu
  ]
];

export function injectionSignals(text) {
  const normalized = text.normalize("NFKC").replace(/[\u200b-\u200f\u2060\ufeff]/gu, "");
  return SIGNALS.filter(([, expression]) => expression.test(normalized)).map(([id]) => id);
}

function warning(text, location) {
  const signals = injectionSignals(text);
  return signals.length ? [{ kind: "prompt-injection", ...location, signals }] : [];
}

export function planWarnings(plan, directory) {
  return [
    ...warning(plan.pullRequestTitle ?? "", { source: "pr-title" }),
    ...plan.units.flatMap((unit) =>
      warning(readFileSync(path.join(directory, unit.patchFile), "utf8"), {
        source: "review-unit",
        unit_id: unit.id,
        path: unit.path
      })
    )
  ];
}

export function executionWarnings(messages, trustedFiles = []) {
  const trusted = new Set(trustedFiles.map((file) => path.resolve(file)));
  const calls = new Map();
  const warnings = [];
  for (const entry of messages) {
    if (entry?.type === "result") break;
    if (!Array.isArray(entry?.message?.content)) continue;
    for (const block of entry.message.content) {
      if (entry.type === "assistant" && block.type === "tool_use") calls.set(block.id, block);
      if (entry.type !== "user" || block.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (!call || !["Read", "Grep", "Glob"].includes(call.name)) continue;
      if (
        call.name === "Read" &&
        typeof call.input?.file_path === "string" &&
        trusted.has(path.resolve(call.input.file_path))
      )
        continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      warnings.push(...warning(text, { source: "tool-result", tool: call.name }));
    }
  }
  return mergeWarnings(warnings);
}

export function mergeWarnings(...groups) {
  return [...new Map(groups.flat().map((entry) => [JSON.stringify(entry), entry])).values()];
}
