import { isNpmRegistryHost } from "./lockfile-policy.mjs";

const MAX_DESCRIPTOR_CHARS = 4_096;
const MAX_PACKAGE_NAME_CHARS = 214;
const NAME_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-";
const RANGE_CHARACTERS = `${NAME_CHARACTERS}*+^<>=| `;

function validPackageName(value) {
  if (!value || value.length > MAX_PACKAGE_NAME_CHARS) return false;
  const parts = value.startsWith("@") ? value.slice(1).split("/") : [value];
  if (value.startsWith("@") && parts.length !== 2) return false;
  return parts.every(
    (part) =>
      part && part !== "." && part !== ".." && [...part].every((character) => NAME_CHARACTERS.includes(character))
  );
}

function namedDescriptor(value, allowAlias = true) {
  if (typeof value !== "string" || value.length > MAX_DESCRIPTOR_CHARS) return null;
  const separator = value.indexOf("@", 1);
  if (separator === -1) return null;
  const name = value.slice(0, separator);
  if (!validPackageName(name)) return null;
  const reference = value.slice(separator + 1);
  if (reference.startsWith("npm:")) return allowAlias ? namedDescriptor(reference.slice(4), false) : null;
  if (!reference.trim() || ![...reference].every((character) => RANGE_CHARACTERS.includes(character))) return null;
  return name;
}

function pnpmPackageName(key) {
  if (key.length > MAX_DESCRIPTOR_CHARS) return null;
  const relative = key.startsWith("/") ? key.slice(1) : key;
  const peerStart = relative.indexOf("(");
  const descriptor = peerStart === -1 ? relative : relative.slice(0, peerStart);
  const modern = namedDescriptor(descriptor, false);
  if (modern) return modern;
  const nameEnd = descriptor.indexOf("/", descriptor.startsWith("@") ? descriptor.indexOf("/") + 1 : 0);
  if (nameEnd === -1) return null;
  const name = descriptor.slice(0, nameEnd);
  const version = descriptor.slice(nameEnd + 1).split("_", 1)[0];
  return namedDescriptor(`${name}@${version}`, false);
}

export function withLockfilePackageIdentity(filename, document, source) {
  const location = JSON.parse(source.location);
  let name;
  if (
    filename === "pnpm-lock.yaml" &&
    ["packages", "snapshots"].includes(location[0]) &&
    location.length === 4 &&
    location[2] === "resolution" &&
    location[3] === "tarball"
  ) {
    name = pnpmPackageName(location[1]);
  } else if (
    filename === "bun.lock" &&
    location.length === 3 &&
    location[0] === "packages" &&
    ["0", "1"].includes(location[2])
  ) {
    const entry = document.packages?.[location[1]];
    name = Array.isArray(entry) ? namedDescriptor(entry[0], false) : null;
  } else if (filename === "yarn.lock" && location.length === 2 && location[1] === "resolved") {
    name = Object.hasOwn(document, "__metadata") ? null : namedDescriptor(location[0]);
  } else {
    return source;
  }
  if (name) return { ...source, packageName: name };
  return isNpmRegistryHost(source.host) && source.kind !== "git" ? { ...source, identityUnclassified: true } : source;
}
