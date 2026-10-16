import { createHash } from "node:crypto";
import { compareStrings } from "./ordering.mjs";
import { canonicalLockfileName } from "./repository-paths.mjs";
import { aliasTargets } from "./lockfile-aliases.mjs";
import { redactSecretMaterial } from "./redaction.mjs";

const MAX_SUMMARY_BYTES = 1_500;
const MAX_SUMMARY_INPUT_CHARS = 4_000;
const MAP_FIELDS = new Map([
  ["package-lock.json", ["packages", "dependencies"]],
  ["pnpm-lock.yaml", ["packages", "snapshots", "importers", "overrides", "patchedDependencies"]],
  ["bun.lock", ["packages", "workspaces"]],
  ["flake.lock", ["nodes"]]
]);
const PACKAGE_ARRAY_FILES = new Set(["Cargo.lock", "poetry.lock", "uv.lock", "composer.lock"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return { integer: value.toString() };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function encode(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function redactValue(value) {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.hostname) {
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return redactSecretMaterial(url.href);
      }
    } catch {
      // Non-URL values still pass through secret redaction.
    }
    return redactSecretMaterial(value);
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [redactSecretMaterial(key), redactValue(child)])
    );
  }
  return value;
}

function summary(serialized) {
  if (serialized === undefined) return null;
  const metadata = { sha256: digest(serialized), bytes: Buffer.byteLength(serialized, "utf8") };
  if (serialized.length <= MAX_SUMMARY_INPUT_CHARS) {
    const value = redactValue(JSON.parse(serialized));
    if (Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") <= MAX_SUMMARY_BYTES) return { ...metadata, value };
  }
  return { ...metadata, omitted: "Entry exceeds the summary limit; read the original patch units." };
}

function safeLabel(value) {
  if (typeof value !== "string") return null;
  if (value.length > MAX_SUMMARY_INPUT_CHARS) return `[long identifier: ${digest(value)}]`;
  return redactSecretMaterial(value).slice(0, 300);
}

function explicitReference(value) {
  if (typeof value !== "string") return false;
  const normalized = value
    .trim()
    .replaceAll(/[\t\r\n]/gu, "")
    .toLowerCase();
  return (
    normalized.startsWith("//") ||
    ["https:", "http:", "git+https:", "git+ssh:", "registry+https:"].some((prefix) => normalized.startsWith(prefix))
  );
}

function sourcePaths(filename, value, location) {
  if (!value || typeof value !== "object") return [];
  if (filename === "package-lock.json") {
    if (value.dependencies && Object.values(value.dependencies).some((entry) => entry && typeof entry === "object"))
      return [];
    return explicitReference(value.resolved) ? [[...location, "resolved"]] : [];
  }
  if (filename === "pnpm-lock.yaml")
    return explicitReference(value.resolution?.tarball) ? [[...location, "resolution", "tarball"]] : [];
  if (filename === "bun.lock") return explicitReference(value[1]) ? [[...location, "1"]] : [];
  if (filename === "yarn.lock") return explicitReference(value.resolved) ? [[...location, "resolved"]] : [];
  if (filename === "flake.lock") return explicitReference(value.locked?.url) ? [[...location, "locked", "url"]] : [];
  if (filename === "Cargo.lock") return explicitReference(value.source) ? [[...location, "source"]] : [];
  const fields = filename === "composer.lock" ? ["source", "dist"].filter((key) => value[key]) : ["source"];
  const paths = [];
  for (const field of fields) {
    const source = value[field];
    const keys =
      source && typeof source === "object"
        ? ["url", "git", "registry"].filter((key) => Object.hasOwn(source, key))
        : [];
    if (!keys.length || keys.some((key) => !explicitReference(source[key]))) return [];
    paths.push(...keys.map((key) => [...location, field, key]));
    if (filename === "composer.lock") {
      for (const [index, mirror] of (source.mirrors ?? []).entries()) {
        if (!explicitReference(mirror.url)) return [];
        paths.push([...location, field, "mirrors", String(index), "url"]);
      }
    }
  }
  return paths;
}

function packageName(filename, key, value) {
  if (filename === "package-lock.json") return key.split("node_modules/").at(-1) || value?.name || null;
  return value?.name ?? key;
}

function entriesFor(state, filename) {
  const entries = new Map();
  if (!state) return entries;
  const { document, contents, sources } = state;
  const recognized = new Set(sources.filter((source) => !source.identityUnclassified).map((source) => source.location));
  const add = (location, value, name = null, modeled = false) => {
    const key = JSON.stringify(location);
    entries.set(key, {
      location: key,
      packageName: name,
      serialized: encode(value),
      modeled,
      aliases: aliasTargets(filename, location, value)
    });
  };
  const addPackage = (location, value, name) => {
    const paths = sourcePaths(filename, value, location);
    add(location, value, name, paths.length > 0 && paths.every((entry) => recognized.has(JSON.stringify(entry))));
  };

  if (filename === "go.sum") {
    const modules = new Map();
    for (const line of contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      const [name, version, checksum] = line.split(/\s+/u);
      const versions = modules.get(name) ?? [];
      versions.push({ version, checksum });
      modules.set(name, versions);
    }
    for (const [name, versions] of modules)
      add(
        ["modules", name],
        versions.sort((a, b) => compareStrings(encode(a), encode(b))),
        name
      );
    return entries;
  }
  if (filename === "Gemfile.lock") {
    add([], contents);
    return entries;
  }
  for (const [field, value] of Object.entries(document)) {
    if (MAP_FIELDS.get(filename)?.includes(field) && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, metadata] of Object.entries(value))
        addPackage([field, key], metadata, packageName(filename, key, metadata));
    } else if (
      PACKAGE_ARRAY_FILES.has(filename) &&
      ["package", "packages", "packages-dev"].includes(field) &&
      Array.isArray(value)
    ) {
      const packages = new Map();
      for (const [index, metadata] of value.entries()) {
        const name = typeof metadata?.name === "string" ? metadata.name : `unnamed-${index}`;
        const variants = packages.get(name) ?? [];
        const paths = sourcePaths(filename, metadata, [field, String(index)]);
        variants.push({
          value: metadata,
          modeled: paths.length > 0 && paths.every((entry) => recognized.has(JSON.stringify(entry)))
        });
        packages.set(name, variants);
      }
      for (const [name, variants] of packages) {
        add(
          [field, name],
          variants.map((entry) => entry.value).sort((a, b) => compareStrings(encode(a), encode(b))),
          name,
          variants.every((entry) => entry.modeled)
        );
      }
    } else if (filename === "yarn.lock" && field !== "__metadata") {
      addPackage([field], value, field);
    } else {
      add([field], value);
    }
  }
  return entries;
}

export function changedDependencyEntries(filePath, baseFilePath, base, head) {
  const before = entriesFor(base, canonicalLockfileName(baseFilePath));
  const after = entriesFor(head, canonicalLockfileName(filePath));
  const changes = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(key);
    const current = after.get(key);
    if (filePath === baseFilePath && previous?.serialized === current?.serialized) continue;
    const entry = current ?? previous;
    const aliasChanged = current && (previous?.aliases ?? "[]") !== current.aliases;
    changes.push({
      id: digest(`${filePath}\n${key}`),
      file: filePath,
      ...(filePath !== baseFilePath ? { previousFile: baseFilePath } : {}),
      location: safeLabel(entry.location),
      packageName: safeLabel(entry.packageName),
      change: !previous ? "added" : !current ? "removed" : "modified",
      reason: entry.modeled && !aliasChanged ? "recognized-source" : "unclassified",
      ...(aliasChanged ? { reviewNotice: "alias-target-change" } : {}),
      before: summary(previous?.serialized),
      after: summary(current?.serialized)
    });
  }
  return changes;
}
