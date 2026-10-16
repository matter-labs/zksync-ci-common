import assert from "node:assert/strict";
import path from "node:path";
import yarnLockfile from "@yarnpkg/lockfile";
import hostedGitInfo from "hosted-git-info";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { lockfileSourceViolations, normalizeLockfileSource } from "./lockfile-policy.mjs";
import { canonicalLockfileName, isSafeRepositoryPath } from "./repository-paths.mjs";
import { parseLockfileJson } from "./lockfile-json.mjs";
import { changedDependencyEntries } from "./dependency-changes.mjs";
import { lockfileSourceField } from "./lockfile-fields.mjs";
import { withLockfilePackageIdentity } from "./lockfile-identities.mjs";

const JSON_LOCKFILES = new Set(["package-lock.json", "composer.lock", "flake.lock"]);
const TOML_LOCKFILES = new Set(["Cargo.lock", "poetry.lock", "uv.lock"]);
const NPM_LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]);
const MAX_HOSTED_SPECIFIER_CHARS = 4_096;
const LOCAL_PROTOCOLS = new Set(["file:", "link:", "workspace:", "portal:"]);
const NETWORK_PROTOCOLS = new Set([
  "http:",
  "https:",
  "git:",
  "git+https:",
  "git+ssh:",
  "ssh:",
  "ftp:",
  "registry+https:"
]);

function gitSource(value) {
  const normalized = value.trim().replaceAll(/[\t\r\n]/gu, "");
  if (normalized.startsWith("//")) return `git+https:${normalized}`;
  return normalized.toLowerCase().startsWith("https:") ? `git+${normalized}` : normalized;
}

function parseYaml(contents) {
  const document = parseDocument(contents, { merge: true, stringKeys: true, prettyErrors: false });
  assert(document.errors.length === 0 && document.warnings.length === 0, "invalid or unsupported YAML lockfile");
  return document.toJS({ maxAliasCount: 100 });
}

function parseYarn(contents) {
  let classic;
  try {
    classic = yarnLockfile.parse(contents);
  } catch {
    const modern = parseYaml(contents);
    assert(modern && typeof modern.__metadata === "object", "unsupported Yarn lockfile");
    return modern;
  }
  assert(classic.type === "success", "invalid or conflicted Yarn lockfile");
  return Object.hasOwn(classic.object, "__metadata") ? parseYaml(contents) : classic.object;
}

function parseLockfile(filename, contents) {
  if (JSON_LOCKFILES.has(filename)) return parseLockfileJson(contents);
  if (TOML_LOCKFILES.has(filename)) return parseToml(contents);
  if (filename === "pnpm-lock.yaml") return parseYaml(contents);
  if (filename === "bun.lock") return parseLockfileJson(contents, true);
  if (filename === "yarn.lock") return parseYarn(contents);
  if (filename === "Gemfile.lock") {
    let section;
    const remotes = [];
    for (const rawLine of contents.split("\n")) {
      const line = rawLine.trimEnd();
      if (/^[A-Z][A-Z ]*$/u.test(line)) section = line;
      const remote = /^ {2}remote: (\S+)\s*$/u.exec(line)?.[1];
      assert(!line.trimStart().startsWith("remote:") || remote, "unsupported Bundler remote");
      if (remote && section !== "PATH") {
        assert(section === "GIT" || section === "GEM", "unsupported Bundler remote section");
        remotes.push(section === "GIT" ? gitSource(remote) : remote);
      }
    }
    return { remotes };
  }
  if (filename === "go.sum") {
    assert(
      contents.split("\n").every((line) => !line.trim() || /^\S+ \S+ h1:[A-Za-z0-9+/]+=*\s*$/u.test(line)),
      "invalid Go checksum file"
    );
    return {};
  }
  throw new Error("unsupported lockfile format");
}

function hostedOrigin(hosted, original) {
  if (original.pathname.includes("%")) return null;
  const canonical = new URL(hosted.https({ noCommittish: true, noGitPlus: true }));
  canonical.port = original.port;
  return normalizeLockfileSource(canonical.href);
}

function sourceRecord(source, location, packageName, npmHosted = false) {
  let url;
  try {
    url = new URL(source.toLowerCase().startsWith("registry+") ? source.slice("registry+".length) : source);
  } catch {
    throw new Error("invalid lockfile source URL");
  }
  assert(url.hostname, "lockfile source URL has no host");
  const hosted = npmHosted && source.length <= MAX_HOSTED_SPECIFIER_CHARS ? hostedGitInfo.fromUrl(source) : null;
  if (npmHosted && ["gitlab.com", "bitbucket.org", "gist.github.com", "git.sr.ht"].includes(url.hostname)) {
    assert(source.length <= MAX_HOSTED_SPECIFIER_CHARS, "hosted Git source exceeds validation limits");
  }
  return {
    source: url.href,
    host: url.hostname.toLowerCase(),
    protocol: url.protocol,
    origin: hosted ? hostedOrigin(hosted, url) : normalizeLockfileSource(url.href),
    kind: source.toLowerCase().startsWith("registry+")
      ? "registry"
      : hosted || url.protocol.startsWith("git+")
        ? "git"
        : "url",
    location,
    ...(packageName ? { packageName } : {})
  };
}

function sourcesInString(value, location, packageName, npmHosted = false) {
  const text = value.trim().replaceAll(/[\t\r\n]/gu, "");
  const record = (source) => sourceRecord(source, location, packageName, npmHosted);
  if (text.startsWith("//")) return [record(`https:${text}`)];
  if (text.toLowerCase().startsWith("ssh://git@")) return [record(`git+${text}`)];
  const ssh = /^git@([a-z0-9.-]+):/iu.exec(text);
  if (ssh) return [record(`git+ssh://git@${ssh[1]}/${text.slice(ssh[0].length)}`)];
  const protocol = /^[a-z][a-z\d+.-]*:/iu.exec(text)?.[0].toLowerCase();
  if (LOCAL_PROTOCOLS.has(protocol)) return [];
  if (NETWORK_PROTOCOLS.has(protocol)) return [record(text)];
  if (npmHosted) {
    const shorthand = ["github:", "gitlab:", "bitbucket:", "gist:", "sourcehut:"].includes(protocol);
    if (shorthand) assert(text.length <= MAX_HOSTED_SPECIFIER_CHARS, "hosted Git source exceeds validation limits");
    const hosted = text.length <= MAX_HOSTED_SPECIFIER_CHARS ? hostedGitInfo.fromUrl(text) : null;
    if (hosted) return [record(hosted.https())];
    assert(!shorthand, "unsupported hosted Git shorthand");
  }
  const sources = [];
  for (let index = 0; index < text.length; ) {
    if (!/[a-z]/iu.test(text[index])) {
      index += 1;
      continue;
    }
    const start = index++;
    while (index < text.length && /[a-z\d+.-]/iu.test(text[index])) index += 1;
    if (text.slice(index, index + 3) !== "://") continue;
    index += 3;
    while (index < text.length && !/[\s"'<>()[\]{},]/u.test(text[index])) index += 1;
    sources.push(record(text.slice(start, index)));
  }
  return sources;
}

function npmPackageNames(lockfile) {
  const packages = lockfile.packages ?? {};
  assert(packages && typeof packages === "object" && !Array.isArray(packages), "invalid npm packages map");
  const expectedNames = new Map();
  for (const [parentPath, metadata] of Object.entries(packages)) {
    assert(!parentPath || isSafeRepositoryPath(parentPath), "invalid npm package path");
    assert(metadata && typeof metadata === "object" && !Array.isArray(metadata), "invalid npm package entry");
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, specifier] of Object.entries(metadata[field] ?? {})) {
        const target =
          (typeof specifier === "string" && /^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/u.exec(specifier)?.[1]) || name;
        let directory = parentPath;
        while (true) {
          const installedPath = [directory, "node_modules", name].filter(Boolean).join("/");
          if (Object.hasOwn(packages, installedPath)) {
            const names = expectedNames.get(installedPath) ?? new Set();
            names.add(target);
            expectedNames.set(installedPath, names);
            break;
          }
          if (!directory) break;
          const parent = path.posix.dirname(directory);
          directory = parent === "." ? "" : parent;
        }
      }
    }
  }
  return new Map(
    Object.entries(packages).map(([packagePath, metadata]) => {
      const marker = "node_modules/";
      const index = packagePath.lastIndexOf(marker);
      const installedName = index === -1 ? metadata.name : packagePath.slice(index + marker.length);
      const requested = expectedNames.get(packagePath);
      assert(!requested || requested.size === 1, "conflicting npm package identities");
      const name = requested ? [...requested][0] : installedName;
      return [packagePath, name];
    })
  );
}

function validateComposerMirrors(document) {
  for (const field of ["packages", "packages-dev"]) {
    const packages = document[field] ?? [];
    assert(Array.isArray(packages), "invalid Composer package list");
    for (const pkg of packages) {
      assert(pkg && typeof pkg === "object" && !Array.isArray(pkg), "invalid Composer package");
      for (const kind of ["source", "dist"]) {
        const mirrors = pkg[kind]?.mirrors;
        if (mirrors === undefined) continue;
        assert(Array.isArray(mirrors), "invalid Composer mirrors");
        for (const mirror of mirrors) {
          assert(typeof mirror?.url === "string" && !mirror.url.includes("%"), "unsupported Composer mirror URL");
          let url;
          try {
            url = new URL(mirror.url);
          } catch {
            throw new Error("invalid Composer mirror URL");
          }
          assert(
            url.hostname && NETWORK_PROTOCOLS.has(url.protocol),
            "Composer mirrors require supported absolute URLs"
          );
          assert(["git", "zip", "tar"].includes(pkg[kind].type), "unsupported Composer mirror type");
        }
      }
    }
  }
}

function withSourceBinding(filename, document, source) {
  if (!["Cargo.lock", "poetry.lock", "uv.lock", "composer.lock"].includes(filename)) return source;
  const location = JSON.parse(source.location);
  const pkg = document[location[0]]?.[location[1]];
  if (!pkg || typeof pkg.name !== "string") return source;
  assert(
    pkg.version === undefined || typeof pkg.version === "string" || typeof pkg.version === "number",
    "invalid package version"
  );
  const metadata = pkg[location[2]];
  const revisions = ["reference", "resolved_reference"].map((field) => metadata?.[field] ?? null);
  assert(
    revisions.every((value) => value === null || typeof value === "string" || typeof value === "number"),
    "invalid source revision"
  );
  return {
    ...source,
    binding: JSON.stringify([location[0], pkg.name, pkg.version ?? null, location.slice(2), revisions])
  };
}

function readLockfileState(filePath, contents) {
  if (contents === null) return null;
  const filename = canonicalLockfileName(filePath);
  let document;
  try {
    document = parseLockfile(filename, contents);
  } catch {
    throw new Error(
      `Cannot validate ${filePath}: invalid or unsupported lockfile format; no text-scanner fallback is allowed.`
    );
  }
  assert(
    document && typeof document === "object" && !Array.isArray(document),
    `invalid lockfile structure: ${filePath}`
  );
  if (filename === "composer.lock") validateComposerMirrors(document);
  const npmHosted = NPM_LOCKFILES.has(filename);
  const packageNames = filename === "package-lock.json" ? npmPackageNames(document) : new Map();
  const sources = [];
  const pending = [{ value: document, location: [] }];
  let visited = 0;
  while (pending.length) {
    const { value, location, packageName, sourceKind } = pending.pop();
    assert(++visited <= 1_000_000 && location.length <= 100, "lockfile structure exceeds validation limits");
    if (typeof value === "string" && sourceKind) {
      const source = sourceKind === "git" ? gitSource(value) : value;
      const records = sourcesInString(source, JSON.stringify(location), packageName, npmHosted);
      sources.push(...records.map((record) => (sourceKind === "git" ? { ...record, kind: "git" } : record)));
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const childPath = [...location, key];
        const keyPath = [...childPath, "<key>"];
        if (lockfileSourceField(filename, keyPath, value, document)) {
          sources.push(...sourcesInString(key, JSON.stringify(keyPath), undefined, npmHosted));
        }
        const kind = lockfileSourceField(filename, childPath, value, document);
        let name;
        if (filename === "package-lock.json" && key === "resolved" && kind) {
          assert(typeof child === "string", "invalid npm resolved source");
          name = location.length === 2 && location[0] === "packages" ? packageNames.get(location[1]) : undefined;
          if (location.at(-2) === "dependencies") {
            name =
              (typeof value.version === "string" && /^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/u.exec(value.version)?.[1]) ||
              location.at(-1);
          }
        }
        pending.push({ value: child, location: childPath, packageName: name, sourceKind: kind });
      }
    }
  }
  return {
    document,
    contents,
    sources: sources.map((source) =>
      withSourceBinding(filename, document, withLockfilePackageIdentity(filename, document, source))
    )
  };
}

export function readLockfileSources(filePath, contents) {
  return readLockfileState(filePath, contents)?.sources ?? [];
}

export function validateLockfileChanges({
  filePath,
  baseFilePath = filePath,
  baseContents,
  headContents,
  allowedHosts = [],
  allowedSources = []
}) {
  const baseState = readLockfileState(baseFilePath, baseContents);
  const headState = readLockfileState(filePath, headContents);
  const base = baseState?.sources ?? [];
  const head = headState?.sources ?? [];
  const identity = (source) =>
    JSON.stringify([source.binding ?? source.location, source.packageName, source.kind, source.source]);
  const previous = new Set(base.map(identity));
  const sources = head.filter((source) => !previous.has(identity(source)));
  const violations = lockfileSourceViolations(sources, allowedHosts, allowedSources);
  return {
    sources,
    violations,
    dependencyChanges: changedDependencyEntries(filePath, baseFilePath, baseState, headState)
  };
}
