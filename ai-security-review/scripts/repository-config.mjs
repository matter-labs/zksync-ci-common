import { readFileSync } from "node:fs";
import { assert } from "./assert.mjs";
import { validateGlob } from "./globs.mjs";
import { normalizeLockfileSource } from "./lockfile-policy.mjs";
import { validateProfileId } from "./profiles.mjs";
import { isSafeRepositoryPath } from "./repository-paths.mjs";

const CONFIG_SCHEMA = JSON.parse(
  readFileSync(new URL("../schemas/repository-config.schema.json", import.meta.url), "utf8")
);
const CONFIG_PROPERTIES = CONFIG_SCHEMA.properties;
const PATH_PROFILE_SCHEMA = CONFIG_PROPERTIES.pathProfiles.items;

function assertArrayOfStrings(value, name, schema) {
  const minimumItems = schema.minItems ?? 0;
  const minimumLength = schema.items.minLength ?? 1;
  assert(Array.isArray(value), `${name} must be an array`);
  assert(value.length <= schema.maxItems, `${name} may contain at most ${schema.maxItems} entries`);
  assert(value.length >= minimumItems, `${name} must contain at least ${minimumItems} entries`);
  if (schema.uniqueItems) assert(new Set(value).size === value.length, `${name} must be unique`);
  for (const item of value) {
    assert(
      typeof item === "string" && item.length >= minimumLength,
      `${name} entries must contain at least ${minimumLength} characters`
    );
    if (schema.items.maxLength !== undefined) {
      assert(
        item.length <= schema.items.maxLength,
        `${name} entries may contain at most ${schema.items.maxLength} characters`
      );
    }
  }
}

function isAsciiLowercaseLetterOrDigit(character) {
  return (character >= "a" && character <= "z") || (character >= "0" && character <= "9");
}

function isValidLockfileHostname(hostname) {
  if (
    hostname.length === 0 ||
    hostname.length > CONFIG_PROPERTIES.allowedLockfileHosts.items.maxLength ||
    hostname !== hostname.toLowerCase()
  )
    return false;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      isAsciiLowercaseLetterOrDigit(label[0]) &&
      isAsciiLowercaseLetterOrDigit(label[label.length - 1]) &&
      [...label].every((character) => isAsciiLowercaseLetterOrDigit(character) || character === "-")
  );
}

export function validateRepositoryConfig(value, profilesRoot) {
  assert(value && typeof value === "object" && !Array.isArray(value), "repository configuration must be an object");
  for (const key of Object.keys(value)) {
    assert(Object.hasOwn(CONFIG_PROPERTIES, key), `repository configuration contains unknown key: ${key}`);
  }
  assert(
    value.version === CONFIG_PROPERTIES.version.const,
    `repository configuration version must be ${CONFIG_PROPERTIES.version.const}`
  );

  const {
    profiles = [],
    context = [],
    pathProfiles = [],
    allowedLockfileHosts = [],
    allowedLockfileSources = [],
    groupRoots = []
  } = value;
  for (const [name, values] of Object.entries({
    profiles,
    context,
    allowedLockfileHosts,
    allowedLockfileSources,
    groupRoots
  })) {
    assertArrayOfStrings(values, name, CONFIG_PROPERTIES[name]);
  }
  assert(
    Array.isArray(pathProfiles) && pathProfiles.length <= CONFIG_PROPERTIES.pathProfiles.maxItems,
    `pathProfiles must be an array containing at most ${CONFIG_PROPERTIES.pathProfiles.maxItems} entries`
  );

  for (const hostname of allowedLockfileHosts) {
    assert(isValidLockfileHostname(hostname), `invalid lockfile hostname: ${hostname}`);
  }
  for (const source of allowedLockfileSources) {
    assert(normalizeLockfileSource(source) === source, `invalid lockfile source: ${source}`);
  }

  for (const profile of profiles) {
    validateProfileId(profile, profilesRoot);
  }
  for (const contextPath of context) {
    assert(isSafeRepositoryPath(contextPath), `unsafe context path: ${contextPath}`);
  }
  for (const groupRoot of groupRoots) {
    assert(isSafeRepositoryPath(groupRoot), `unsafe group root: ${groupRoot}`);
  }
  for (const [index, entry] of pathProfiles.entries()) {
    assert(entry && typeof entry === "object" && !Array.isArray(entry), `pathProfiles[${index}] must be an object`);
    for (const key of Object.keys(entry)) {
      assert(Object.hasOwn(PATH_PROFILE_SCHEMA.properties, key), `pathProfiles[${index}] contains unknown key: ${key}`);
    }
    assertArrayOfStrings(entry.paths, `pathProfiles[${index}].paths`, PATH_PROFILE_SCHEMA.properties.paths);
    assertArrayOfStrings(entry.profiles, `pathProfiles[${index}].profiles`, PATH_PROFILE_SCHEMA.properties.profiles);
    for (const pattern of entry.paths) {
      validateGlob(pattern);
    }
    for (const profile of entry.profiles) {
      validateProfileId(profile, profilesRoot);
    }
  }

  return {
    version: value.version,
    profiles,
    context,
    pathProfiles,
    allowedLockfileHosts,
    allowedLockfileSources,
    groupRoots
  };
}
