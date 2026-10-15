import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRepositoryConfig } from "../scripts/repository-config.mjs";

const profilesRoot = fileURLToPath(new URL("../profiles", import.meta.url));
const examplesRoot = fileURLToPath(new URL("../examples/repository-configs", import.meta.url));

test("repository configuration rejects unknown profiles and arbitrary keys", () => {
  assert.throws(
    () => validateRepositoryConfig({ version: 1, profiles: ["domains/not-real"] }, profilesRoot),
    /unknown profile/u
  );
  assert.throws(() => validateRepositoryConfig({ version: 1, disabled: true }, profilesRoot), /unknown key/u);
  assert.throws(
    () =>
      validateRepositoryConfig({ version: 1, allowedLockfileHosts: ["HTTPS://PACKAGES.EXAMPLE.COM"] }, profilesRoot),
    /invalid lockfile hostname/u
  );
  for (const hostname of ["localhost", "-packages.example.com", "packages.example-.com", `${"a".repeat(64)}.com`]) {
    assert.throws(
      () => validateRepositoryConfig({ version: 1, allowedLockfileHosts: [hostname] }, profilesRoot),
      /invalid lockfile hostname/u
    );
  }
  assert.deepEqual(
    validateRepositoryConfig({ version: 1, allowedLockfileHosts: ["packages.example.com"] }, profilesRoot)
      .allowedLockfileHosts,
    ["packages.example.com"]
  );
  assert.throws(
    () =>
      validateRepositoryConfig(
        { version: 1, allowedLockfileSources: ["https://github.com/org/repo.git"] },
        profilesRoot
      ),
    /invalid lockfile source/u
  );
  assert.deepEqual(
    validateRepositoryConfig(
      { version: 1, allowedLockfileSources: ["https://github.com/matter-labs/example"] },
      profilesRoot
    ).allowedLockfileSources,
    ["https://github.com/matter-labs/example"]
  );
});

test("all example repository configurations are valid", () => {
  for (const filename of readdirSync(examplesRoot)) {
    const config = JSON.parse(readFileSync(`${examplesRoot}/${filename}`, "utf8"));
    assert.doesNotThrow(() => validateRepositoryConfig(config, profilesRoot), filename);
  }
});

test("repository configuration enforces the schema's array and string constraints", () => {
  for (const field of [
    "profiles",
    "context",
    "pathProfiles",
    "allowedLockfileHosts",
    "allowedLockfileSources",
    "groupRoots"
  ]) {
    assert.throws(() => validateRepositoryConfig({ version: 1, [field]: null }, profilesRoot), /array/u);
  }
  for (const config of [
    { profiles: ["domains/authorization", "domains/authorization"] },
    { context: ["SECURITY.md", "SECURITY.md"] },
    { pathProfiles: [{ paths: [], profiles: ["domains/authorization"] }] },
    { pathProfiles: [{ paths: ["**/*.ts"], profiles: [] }] },
    { pathProfiles: [{ paths: ["**/*.ts"], profiles: ["domains/authorization", "domains/authorization"] }] },
    { context: ["x".repeat(301)] },
    { groupRoots: ["x".repeat(301)] }
  ]) {
    assert.throws(() => validateRepositoryConfig({ version: 1, ...config }, profilesRoot));
  }
});

test("schema patterns and runtime agree on canonical source and hostname examples", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/repository-config.schema.json", import.meta.url), "utf8"));
  for (const [field, value, expected] of [
    ["allowedLockfileHosts", "packages.example.com", true],
    ["allowedLockfileHosts", "localhost", false],
    ["allowedLockfileHosts", "PACKAGES.EXAMPLE.COM", false],
    ["allowedLockfileSources", "https://github.com/matter-labs/example", true],
    ["allowedLockfileSources", "https://git.example.com:8443/org/repo", true],
    ["allowedLockfileSources", "https://github.com/matter-labs/example.git", false],
    ["allowedLockfileSources", "https://github.com/matter-labs/example/", false],
    ["allowedLockfileSources", "https://user@github.com/matter-labs/example", false],
    ["allowedLockfileSources", "https://github.com/matter-labs/example?ref=main", false]
  ]) {
    const rules = schema.properties[field].items;
    const schemaMatches =
      new RegExp(rules.pattern, "u").test(value) && (!rules.not || !new RegExp(rules.not.pattern, "u").test(value));
    assert.equal(schemaMatches, expected, `${field}: ${value}`);
    const validate = () => validateRepositoryConfig({ version: 1, [field]: [value] }, profilesRoot);
    if (expected) assert.doesNotThrow(validate);
    else assert.throws(validate);
  }
});
