import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isSourcePath, orderedProfiles, profilesForPath } from "../scripts/profiles.mjs";
import { validateRepositoryConfig } from "../scripts/repository-config.mjs";

const profilesRoot = fileURLToPath(new URL("../profiles", import.meta.url));
const emptyConfig = { version: 1, profiles: [], context: [], pathProfiles: [] };

test("profile ordering deduplicates without mutating input and puts universal first", () => {
  const profiles = Object.freeze([
    "languages/rust",
    "universal",
    "domains/authorization",
    "universal",
    "languages/rust"
  ]);
  assert.deepEqual(orderedProfiles(profiles), ["universal", "domains/authorization", "languages/rust"]);
  assert.deepEqual(orderedProfiles(new Set(profiles)), orderedProfiles(profiles));
  assert.deepEqual(orderedProfiles([]), []);
});

test("profile selection composes universal, language, infrastructure, and repository profiles", () => {
  const config = validateRepositoryConfig(
    {
      version: 1,
      profiles: ["domains/distributed-system", "domains/privacy-data-exposure"],
      pathProfiles: [{ paths: [".github/**"], profiles: ["domains/authorization"] }]
    },
    profilesRoot
  );
  assert.deepEqual(profilesForPath(".github/workflows/review.ts", config), [
    "universal",
    "domains/authorization",
    "domains/ci-supply-chain",
    "domains/distributed-system",
    "domains/privacy-data-exposure",
    "languages/typescript-javascript"
  ]);
  assert.deepEqual(profilesForPath("src/lib.rs", emptyConfig), ["universal", "languages/rust"]);
});

test("profile selection recognizes infrastructure as code and additional repository languages", () => {
  assert.deepEqual(profilesForPath("clusters/mainnet/values.yaml", emptyConfig), [
    "universal",
    "domains/infrastructure-as-code"
  ]);
  assert.deepEqual(profilesForPath("modules/network/main.tf", emptyConfig), [
    "universal",
    "domains/ci-supply-chain",
    "domains/infrastructure-as-code"
  ]);
  assert.deepEqual(profilesForPath("src/handler.py", emptyConfig), ["universal", "languages/python"]);
  assert.deepEqual(profilesForPath("cmd/server/main.go", emptyConfig), ["universal", "languages/go"]);
  assert.deepEqual(profilesForPath("crypto/kernel.cu", emptyConfig), ["universal", "languages/native"]);
  assert.deepEqual(profilesForPath("scripts/release.sh", emptyConfig), ["universal", "languages/shell"]);
  assert.deepEqual(profilesForPath("contracts/bootloader.yul", emptyConfig), ["universal", "languages/solidity"]);
  assert.deepEqual(profilesForPath("Cargo.toml", emptyConfig), ["universal", "domains/ci-supply-chain"]);
  assert.deepEqual(profilesForPath("requirements-prod.txt", emptyConfig), ["universal", "domains/ci-supply-chain"]);
});

test("source extensions are recognized for binary enforcement", () => {
  assert.equal(isSourcePath("src/auth.ts"), true);
  assert.equal(isSourcePath("core/lib.rs"), true);
  assert.equal(isSourcePath("assets/data.dat"), false);
  assert.equal(isSourcePath("README.md"), false);
});
