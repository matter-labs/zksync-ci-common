import { assert } from "./assert.mjs";

const DEFAULT_LOCKFILE_HOSTS = new Set([
  "crates.io",
  "files.pythonhosted.org",
  "index.crates.io",
  "packagist.org",
  "plugins.gradle.org",
  "proxy.golang.org",
  "pypi.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.maven.apache.org",
  "rubygems.org",
  "static.crates.io",
  "sum.golang.org"
]);

const NPM_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
const DEFAULT_REGISTRY_SOURCES = new Set(["https://github.com/rust-lang/crates.io-index"]);
const SUPPORTED_SOURCE_PROTOCOLS = new Set(["https:", "git+https:", "git+ssh:"]);

export function isNpmRegistryHost(host) {
  return NPM_REGISTRY_HOSTS.has(host);
}

function hasSourceCredentials(url) {
  return Boolean(url.password || (url.username && !(url.protocol === "git+ssh:" && url.username === "git")));
}

function isGitHubHost(host) {
  return host === "github.com" || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com");
}

function githubRepositoryOrigin(url) {
  if (url.port || url.pathname.includes("%")) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").slice(1);
  if (host === "api.github.com") {
    if (parts.shift() !== "repos") return null;
  } else if (!["github.com", "codeload.github.com", "raw.githubusercontent.com"].includes(host)) {
    return null;
  }
  const [owner, repository] = parts;
  if (!owner || !repository || ![owner, repository].every((part) => /^[a-zA-Z0-9_.-]+$/u.test(part))) return null;
  if ([owner, repository].some((part) => part === "." || part === "..")) return null;
  return `https://github.com/${owner}/${repository.replace(/\.git$/u, "")}`;
}

export function normalizeLockfileSource(value) {
  try {
    const url = new URL(value);
    if (!SUPPORTED_SOURCE_PROTOCOLS.has(url.protocol) || hasSourceCredentials(url)) return null;
    const pathname = url.pathname.replace(/\/$/u, "").replace(/\.git$/u, "");
    if (!url.hostname || !pathname) return null;
    return `https://${url.host.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

function npmRegistrySourceMatches(packageName, source) {
  try {
    const url = new URL(source);
    const pathname = decodeURIComponent(url.pathname).replace(/^\//u, "");
    return pathname.startsWith(`${packageName}/-/`);
  } catch {
    return false;
  }
}

export function lockfileSourceViolations(sources, allowedHosts = [], allowedSources = []) {
  assert(Array.isArray(sources), "lockfile policy requires parsed source records");
  const approvedHosts = new Set([...DEFAULT_LOCKFILE_HOSTS, ...allowedHosts]);
  const approvedSources = new Set(allowedSources.map(normalizeLockfileSource).filter(Boolean));
  return sources.flatMap((source) => {
    const url = new URL(source.source);
    if (hasSourceCredentials(url)) {
      return [{ host: source.host, reason: "embedded-credentials" }];
    }
    if (!SUPPORTED_SOURCE_PROTOCOLS.has(url.protocol)) {
      return [{ host: source.host, reason: "insecure-protocol" }];
    }
    if (source.kind === "registry" && DEFAULT_REGISTRY_SOURCES.has(source.origin)) return [];
    if (source.kind === "git" || source.protocol.startsWith("git+") || isGitHubHost(source.host)) {
      const origin = isGitHubHost(source.host) ? githubRepositoryOrigin(url) : source.origin;
      return approvedSources.has(origin) ? [] : [{ host: source.host, reason: "unapproved-source" }];
    }
    if (isNpmRegistryHost(source.host) && url.port) return [{ host: source.host, reason: "unapproved-port" }];
    if (!approvedHosts.has(source.host)) return [{ host: source.host, reason: "unapproved-host" }];
    if (
      isNpmRegistryHost(source.host) &&
      source.packageName &&
      !npmRegistrySourceMatches(source.packageName, source.source)
    ) {
      return [{ host: source.host, reason: "source-identity-mismatch" }];
    }
    return [];
  });
}
