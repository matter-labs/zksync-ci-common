export const unclassifiedDependencies = [
  {
    name: "npm missing resolution",
    file: "package-lock.json",
    locations: [["packages", "node_modules/pkg"]],
    contents: JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/pkg": { version: "1.0.0" } } })
  },
  ...["github:attacker/evil#123", "exec:./generate.js", "patch:pkg@npm%3A1.0.0#./pkg.patch"].map((locator) => ({
    name: `Yarn ${locator}`,
    file: "yarn.lock",
    locations: [[`pkg@${locator}`]],
    contents: `__metadata:\n  version: 8\n"pkg@${locator}":\n  version: 1.0.0\n  resolution: "pkg@${locator}"\n`
  })),
  {
    name: "pnpm implicit alias",
    file: "pnpm-lock.yaml",
    locations: [
      ["importers", "."],
      ["packages", "evil@1.0.0"]
    ],
    contents:
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      safe:\n        specifier: npm:evil@1.0.0\n        version: evil@1.0.0\npackages:\n  evil@1.0.0:\n    resolution: {integrity: sha512-test}\n"
  },
  {
    name: "Bun implicit alias",
    file: "bun.lock",
    locations: [["packages", "safe"]],
    contents: JSON.stringify({ lockfileVersion: 1, packages: { safe: ["evil@1.0.0", "", {}, "sha512-test"] } })
  },
  {
    name: "pnpm ambiguous package identity",
    file: "pnpm-lock.yaml",
    locations: [["packages", "opaque-descriptor"]],
    contents: JSON.stringify({
      packages: {
        "opaque-descriptor": {
          resolution: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" }
        }
      }
    })
  },
  {
    name: "Bun ambiguous package identity",
    file: "bun.lock",
    locations: [["packages", "pkg"]],
    contents: JSON.stringify({
      packages: { pkg: ["unmodeled:descriptor", "https://registry.yarnpkg.com/pkg/-/pkg-1.0.0.tgz", {}, "sha512-test"] }
    })
  },
  {
    name: "Yarn Classic ambiguous package identity",
    file: "yarn.lock",
    locations: [["pkg@unmodeled:descriptor"]],
    contents:
      '"pkg@unmodeled:descriptor":\n  version "1.0.0"\n  resolved "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"\n'
  },
  {
    name: "structured Nix GitHub input",
    file: "flake.lock",
    locations: [["nodes", "pkg"]],
    contents: JSON.stringify({
      version: 7,
      root: "root",
      nodes: {
        root: { inputs: { pkg: "pkg" } },
        pkg: { locked: { type: "github", owner: "attacker", repo: "evil", rev: "123" } }
      }
    })
  },
  {
    name: "Go checksum",
    file: "go.sum",
    locations: [["modules", "github.com/attacker/evil"]],
    contents: "github.com/attacker/evil v1.0.0 h1:abcdef=\n"
  },
  {
    name: "local dependency archive",
    file: "package-lock.json",
    locations: [["packages", "node_modules/pkg"]],
    contents: JSON.stringify({ packages: { "node_modules/pkg": { resolved: "file:vendor/pkg.tar.gz" } } })
  }
];
