import { createHash } from "node:crypto";
import { compareStrings } from "./ordering.mjs";

const NPM_LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]);

function target(value) {
  const start = value.indexOf("npm:");
  if (start === -1) return null;
  if (value.length > 4_096) return `unclassified:${createHash("sha256").update(value).digest("hex")}`;
  const specifier = value.slice(start + 4);
  const end = specifier.indexOf("@", specifier.startsWith("@") ? 1 : 0);
  if (start > 0 && end === -1) return null;
  return end === -1 ? specifier : specifier.slice(0, end);
}

export function aliasTargets(filename, location, value) {
  if (!NPM_LOCKFILES.has(filename)) return "[]";
  const aliases = [];
  const pending = [{ value, path: [] }];
  if (filename === "yarn.lock") {
    const name = target(location[0]);
    if (name !== null) aliases.push(["<selector>", name]);
  }
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry.value === "string") {
      const name = target(entry.value);
      if (name !== null) aliases.push([JSON.stringify(entry.path), name]);
    } else if (entry.value && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value)) {
        pending.push({ value: child, path: [...entry.path, key] });
      }
    }
  }
  return JSON.stringify(aliases.sort((left, right) => compareStrings(left[0], right[0])));
}
