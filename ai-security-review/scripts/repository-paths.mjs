import path from "node:path";

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".tiff",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip"
]);

const LOCKFILES = new Set([
  "Cargo.lock",
  "Gemfile.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "flake.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock"
]);

export function isSafeRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    return false;
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value) || path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}

export function eligibilityForPath(filePath) {
  if (!isSafeRepositoryPath(filePath)) {
    return { eligible: false, reason: "unsafe-path" };
  }
  return { eligible: true };
}

export function isKnownBinaryPath(filePath) {
  return BINARY_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

export function isLockfilePath(filePath) {
  return LOCKFILES.has(canonicalLockfileName(filePath));
}

export function canonicalLockfileName(filePath) {
  const name = path.posix.basename(filePath);
  if (name === "npm-shrinkwrap.json") return "package-lock.json";
  if (name === "gems.locked") return "Gemfile.lock";
  return name;
}
