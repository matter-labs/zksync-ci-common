import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compareStrings } from "./ordering.mjs";
import { assert } from "./assert.mjs";
import { matchesGlob } from "./globs.mjs";
import { isLockfilePath } from "./repository-paths.mjs";

const INFRASTRUCTURE_DIRECTORIES = new Set([
  "ansible",
  "charts",
  "clusters",
  "deploy",
  "deployments",
  "helm",
  "infra",
  "infrastructure",
  "k8s",
  "kubernetes",
  "playbooks"
]);

const SUPPLY_CHAIN_MANIFESTS = new Set([
  ".gitmodules",
  ".npmrc",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "go.mod",
  "go.work",
  "package.json",
  "pyproject.toml",
  "renovate.json"
]);

const LANGUAGE_PROFILES = new Map([
  [".asm", "languages/native"],
  [".bash", "languages/shell"],
  [".c", "languages/native"],
  [".cc", "languages/native"],
  [".cjs", "languages/typescript-javascript"],
  [".cpp", "languages/native"],
  [".cu", "languages/native"],
  [".cuh", "languages/native"],
  [".cxx", "languages/native"],
  [".go", "languages/go"],
  [".h", "languages/native"],
  [".hh", "languages/native"],
  [".hpp", "languages/native"],
  [".hxx", "languages/native"],
  [".js", "languages/typescript-javascript"],
  [".jsx", "languages/typescript-javascript"],
  [".ll", "languages/native"],
  [".mjs", "languages/typescript-javascript"],
  [".mts", "languages/typescript-javascript"],
  [".cts", "languages/typescript-javascript"],
  [".py", "languages/python"],
  [".pyi", "languages/python"],
  [".ts", "languages/typescript-javascript"],
  [".tsx", "languages/typescript-javascript"],
  [".vue", "languages/typescript-javascript"],
  [".rs", "languages/rust"],
  [".s", "languages/native"],
  [".sh", "languages/shell"],
  [".sol", "languages/solidity"],
  [".vy", "languages/solidity"],
  [".yul", "languages/solidity"],
  [".zsh", "languages/shell"]
]);

export function validateProfileId(profileId, profilesRoot) {
  assert(/^(?:languages|domains)\/[a-z0-9-]+$/u.test(profileId), `invalid profile identifier: ${profileId}`);
  assert(existsSync(path.join(profilesRoot, `${profileId}.md`)), `unknown profile: ${profileId}`);
}

function isCiOrSupplyChainPath(filePath) {
  const basename = path.posix.basename(filePath);
  const extension = path.posix.extname(filePath).toLowerCase();
  return (
    filePath.startsWith(".github/actions/") ||
    filePath.startsWith(".github/workflows/") ||
    filePath.startsWith("deploy/") ||
    filePath.startsWith("deployments/") ||
    filePath.includes("/helm/") ||
    filePath.includes("/k8s/") ||
    SUPPLY_CHAIN_MANIFESTS.has(basename) ||
    /^Dockerfile(?:\..+)?$/u.test(basename) ||
    /^docker-compose(?:\..+)?\.ya?ml$/u.test(basename) ||
    /^requirements(?:[-.][^.]+)?\.txt$/u.test(basename) ||
    [".tf", ".tfvars"].includes(extension)
  );
}

function isInfrastructureAsCodePath(filePath) {
  const basename = path.posix.basename(filePath);
  const extension = path.posix.extname(filePath).toLowerCase();
  const directorySegments = filePath.split("/").slice(0, -1);
  return (
    directorySegments.some((segment) => INFRASTRUCTURE_DIRECTORIES.has(segment)) ||
    /^Chart\.ya?ml$/u.test(basename) ||
    /^Pulumi(?:\.[^.]+)?\.ya?ml$/u.test(basename) ||
    /^docker-compose(?:\..+)?\.ya?ml$/u.test(basename) ||
    /^kustomization\.ya?ml$/u.test(basename) ||
    [".sops.yaml", ".sops.yml", "ansible.cfg", "terragrunt.hcl"].includes(basename) ||
    [".bicep", ".hcl", ".pp", ".rego", ".tf", ".tfvars"].includes(extension)
  );
}

export function isSourcePath(filePath) {
  return LANGUAGE_PROFILES.has(path.posix.extname(filePath).toLowerCase());
}

export function profilesForPath(filePath, config) {
  const selected = new Set(["universal"]);
  const languageProfile = LANGUAGE_PROFILES.get(path.posix.extname(filePath).toLowerCase());
  if (languageProfile) {
    selected.add(languageProfile);
  }
  if (isCiOrSupplyChainPath(filePath) || isLockfilePath(filePath)) {
    selected.add("domains/ci-supply-chain");
  }
  if (isInfrastructureAsCodePath(filePath)) {
    selected.add("domains/infrastructure-as-code");
  }
  for (const profile of config.profiles) {
    selected.add(profile);
  }
  for (const entry of config.pathProfiles) {
    if (entry.paths.some((pattern) => matchesGlob(pattern, filePath))) {
      for (const profile of entry.profiles) {
        selected.add(profile);
      }
    }
  }
  return orderedProfiles(selected);
}

export function orderedProfiles(profiles) {
  return [...new Set(profiles)].sort((left, right) => {
    if (left === right) return 0;
    if (left === "universal") return -1;
    if (right === "universal") return 1;
    return compareStrings(left, right);
  });
}

export function loadProfileText(profileIds, profilesRoot) {
  return profileIds
    .map((profileId) => {
      const profilePath = profileId === "universal" ? "universal.md" : `${profileId}.md`;
      return readFileSync(path.join(profilesRoot, profilePath), "utf8").trim();
    })
    .join("\n\n---\n\n");
}
