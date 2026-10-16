import { compareStrings } from "./ordering.mjs";
const IMPORT_SIGNALS = [
  { id: "crypto-library", modules: ["crypto", "node:crypto"], profiles: ["domains/cryptography"] },
  { id: "jwt-library", modules: ["jose", "jsonwebtoken"], profiles: ["domains/authorization", "domains/cryptography"] },
  {
    id: "policy-library",
    modules: ["casbin", "@casl/ability", "@open-policy-agent/opa-wasm"],
    profiles: ["domains/authorization", "domains/policy-engine"]
  },
  {
    id: "http-library",
    modules: ["http", "node:http", "https", "node:https", "undici", "axios"],
    profiles: ["domains/http-service"]
  }
];

const API_SIGNALS = [
  {
    id: "webcrypto-api",
    profiles: ["domains/cryptography"],
    patterns: [
      /\bcrypto\s{0,64}\.\s{0,64}subtle\s{0,64}\.\s{0,64}(?:verify|sign|encrypt|decrypt|deriveKey|deriveBits|generateKey|importKey|exportKey|digest)\s{0,64}\(/u
    ]
  },
  {
    id: "global-fetch-api",
    profiles: ["domains/http-service"],
    patterns: [/\bglobalThis\s{0,64}\.\s{0,64}fetch\s{0,64}\(/u]
  },
  {
    id: "iam-policy-structure",
    profiles: ["domains/authorization", "domains/policy-engine"],
    patterns: [
      /"Statement"\s{0,64}:\s{0,64}\[/u,
      /"Effect"\s{0,64}:\s{0,64}"(?:Allow|Deny)"/u,
      /"(?:Not)?Action"\s{0,64}:/u,
      /"(?:Not)?Resource"\s{0,64}:/u
    ]
  }
];

const SIGNAL_BY_MODULE = new Map(IMPORT_SIGNALS.flatMap((signal) => signal.modules.map((name) => [name, signal])));
const WINDOW_CHARS = 32 * 1024;
// Overlap exceeds the longest bounded signal pattern so window edges cannot hide a match.
const WINDOW_OVERLAP_CHARS = 1024;

export const MAX_CONTENT_FILE_BYTES = 512 * 1024;
export const MAX_CONTENT_TOTAL_BYTES = 16 * 1024 * 1024;

function newlineCount(text, start, end) {
  let count = 0;
  for (let index = start; index < end; index += 1) if (text[index] === "\n") count += 1;
  return count;
}

export function contentProfileSignals(text) {
  const found = new Map();
  const apiMatches = new Map(API_SIGNALS.map((signal) => [signal.id, new Map()]));
  let firstLine = 1;
  for (let offset = 0; offset < text.length; offset += WINDOW_CHARS) {
    const start = Math.max(0, offset - WINDOW_OVERLAP_CHARS);
    // Prevent a synthetic word boundary at the beginning of a sliced window.
    const window = (start === 0 ? "" : "x") + text.slice(start, offset + WINDOW_CHARS);
    const lineAt = (index) => firstLine + newlineCount(window, 0, index);
    const importPattern =
      /\b(?:from\s{1,64}|import\s{0,64}(?:\(\s{0,64})?|require\s{0,64}\(\s{0,64})["']([^"'\r\n]{1,160})["']/gu;
    for (const match of window.matchAll(importPattern)) {
      const signal = SIGNAL_BY_MODULE.get(match[1]);
      if (signal && !found.has(signal.id))
        found.set(signal.id, { id: signal.id, profiles: signal.profiles, line: lineAt(match.index) });
    }
    for (const signal of API_SIGNALS) {
      if (found.has(signal.id)) continue;
      const matches = apiMatches.get(signal.id);
      for (const [index, pattern] of signal.patterns.entries()) {
        if (matches.has(index)) continue;
        const match = pattern.exec(window);
        if (match) matches.set(index, lineAt(match.index));
      }
      if (matches.size === signal.patterns.length) {
        found.set(signal.id, { id: signal.id, profiles: signal.profiles, line: matches.get(0) });
      }
    }
    const nextStart = Math.max(0, offset + WINDOW_CHARS - WINDOW_OVERLAP_CHARS);
    firstLine += newlineCount(text, start, Math.min(text.length, nextStart));
  }
  return [...found.values()]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((signal) => ({ ...signal, profiles: [...signal.profiles] }));
}

export function patchProfileSignals(chunks, side) {
  const found = new Map();
  for (const chunk of chunks) {
    let firstLine = null;
    let lines = [];
    const record = () => {
      if (firstLine === null) return;
      for (const signal of contentProfileSignals(lines.join("\n"))) {
        if (!found.has(signal.id)) found.set(signal.id, { ...signal, line: firstLine + signal.line - 1 });
      }
    };
    for (const line of chunk.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
      if (hunk) {
        record();
        firstLine = Number(hunk[side === "base" ? 1 : 2]);
        lines = [];
      } else if (firstLine !== null && (line.startsWith(" ") || line.startsWith(side === "base" ? "-" : "+"))) {
        lines.push(line.slice(1));
      }
    }
    record();
  }
  return [...found.values()].sort((left, right) => compareStrings(left.id, right.id));
}

export function combinedContentSignals(base, head) {
  const combined = new Map();
  for (const [side, signals] of [
    ["base", base],
    ["head", head]
  ]) {
    for (const signal of signals) {
      const entry = combined.get(signal.id) ?? { id: signal.id };
      entry[`${side}_line`] = signal.line;
      combined.set(signal.id, entry);
    }
  }
  return [...combined.values()].sort((left, right) => compareStrings(left.id, right.id));
}
