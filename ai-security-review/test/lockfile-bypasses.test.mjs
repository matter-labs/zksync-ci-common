import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateLockfileChanges } from "../scripts/lockfile-sources.mjs";
import { unclassifiedDependencies } from "./dependency-fixtures.mjs";

function npmLock(resolved, name = "pkg") {
  return JSON.stringify({ packages: { [`node_modules/${name}`]: { version: "1.0.0", resolved } } });
}

function check(headContents, options = {}) {
  return validateLockfileChanges({ filePath: "package-lock.json", baseContents: null, headContents, ...options });
}

function identityLockfiles(url, name = "zod", version = "3.22.4") {
  return [
    ["pnpm-lock.yaml", JSON.stringify({ packages: { [`${name}@${version}`]: { resolution: { tarball: url } } } })],
    [
      "pnpm-lock.yaml",
      JSON.stringify({
        packages: {
          [`/${name}@${version}(typescript@5.8.3)(zod@3.22.4)`]: {
            resolution: { tarball: url }
          }
        }
      })
    ],
    [
      "pnpm-lock.yaml",
      JSON.stringify({
        packages: {
          [`/${name}/${version}_typescript@5.8.3`]: {
            resolution: { tarball: url }
          }
        }
      })
    ],
    [
      "pnpm-lock.yaml",
      JSON.stringify({
        snapshots: {
          [`${name}@${version}(typescript@5.8.3)`]: {
            resolution: { tarball: url }
          }
        }
      })
    ],
    ["bun.lock", JSON.stringify({ packages: { [name]: [`${name}@${version}`, url, {}, "sha512-test"] } })],
    ["yarn.lock", `"${name}@^${version}", "${name}@~${version}":\n  version "${version}"\n  resolved "${url}"\n`]
  ];
}

test("pnpm, Bun and Yarn Classic enforce resolved package identities on both npm registry hosts", () => {
  for (const host of ["registry.npmjs.org", "registry.yarnpkg.com"]) {
    for (const name of ["zod", "@scope/pkg"]) {
      const badUrl = `https://${host}/evil-package/-/evil-package-1.0.0.tgz`;
      for (const [filePath, contents] of identityLockfiles(badUrl, name)) {
        const result = check(contents, { filePath });
        assert.ok(result.sources.length > 0, filePath);
        assert.ok(
          result.sources.every((source) => source.packageName === name),
          filePath
        );
        assert.ok(
          result.violations.every((violation) => violation.reason === "source-identity-mismatch"),
          filePath
        );
        assert.equal(result.violations.length, result.sources.length, filePath);
      }
      const goodUrl = `https://${host}/${name}/-/${name.split("/").at(-1)}-3.22.4.tgz`;
      for (const [filePath, contents] of identityLockfiles(goodUrl, name)) {
        const result = check(contents, { filePath });
        assert.deepEqual(result.violations, [], filePath);
        assert.ok(
          result.dependencyChanges.every((entry) => entry.reason === "recognized-source"),
          filePath
        );
        assert.deepEqual(check(contents, { filePath, baseContents: contents }).sources, []);
        const bump = check(contents.replaceAll("3.22.4", "3.22.5"), { filePath, baseContents: contents });
        assert.deepEqual(bump.violations, [], filePath);
        assert.ok(
          bump.sources.every((source) => source.packageName === name),
          filePath
        );
      }
    }
  }
});

test("declared aliases use the resolved target name without inferring it from the tarball URL", () => {
  for (const host of ["registry.npmjs.org", "registry.yarnpkg.com"]) {
    for (const target of ["real-package", "@scope/real-package"]) {
      const url = `https://${host}/${target}/-/real-package-1.0.0.tgz`;
      const fixtures = [
        [
          "pnpm-lock.yaml",
          JSON.stringify({
            importers: {
              ".": { dependencies: { alias: { specifier: `npm:${target}@^1.0.0`, version: `${target}@1.0.0` } } }
            },
            packages: { [`${target}@1.0.0`]: { resolution: { tarball: url } } }
          })
        ],
        [
          "bun.lock",
          JSON.stringify({
            workspaces: { "": { dependencies: { alias: `npm:${target}@^1.0.0` } } },
            packages: { alias: [`${target}@1.0.0`, url, {}, "sha512-test"] }
          })
        ],
        ["yarn.lock", `"alias@npm:${target}@^1.0.0":\n  version "1.0.0"\n  resolved "${url}"\n`]
      ];
      for (const [filePath, contents] of fixtures) {
        const good = check(contents, { filePath });
        assert.deepEqual(good.violations, [], filePath);
        assert.ok(
          good.sources.every((source) => source.packageName === target),
          filePath
        );
        const bad = check(contents.replace(url, `https://${host}/alias/-/alias-1.0.0.tgz`), { filePath });
        assert.equal(bad.violations[0]?.reason, "source-identity-mismatch", filePath);
      }
    }
  }
});

test("identity enrichment preserves origin, protocol, credential and port checks", () => {
  for (const [url, reason] of [
    ["https://private.example.com/pkg.tgz", "unapproved-host"],
    ["https://github.com/attacker/pkg/archive/main.tgz", "unapproved-source"],
    ["http://registry.npmjs.org/zod/-/zod-3.22.4.tgz", "insecure-protocol"],
    ["https://user:pass@registry.yarnpkg.com/zod/-/zod-3.22.4.tgz", "embedded-credentials"],
    ["https://registry.npmjs.org:8443/zod/-/zod-3.22.4.tgz", "unapproved-port"]
  ]) {
    for (const [filePath, contents] of identityLockfiles(url))
      assert.equal(check(contents, { filePath }).violations[0]?.reason, reason, filePath);
  }
});

test("changing only a declared identity rechecks a previously approved source binding", () => {
  const url = "https://registry.npmjs.org/zod/-/zod-3.22.4.tgz";
  const base = JSON.stringify({ packages: { alias: ["zod@3.22.4", url, {}, "sha512-test"] } });
  const result = check(base.replace('"zod@3.22.4"', '"other@3.22.4"'), { filePath: "bun.lock", baseContents: base });
  assert.equal(result.sources[0]?.packageName, "other");
  assert.equal(result.violations[0]?.reason, "source-identity-mismatch");
});

test("URLs embedded in pnpm peer suffixes do not inherit the parent package's identity", () => {
  const key = "parent@1.0.0(peer@https://registry.npmjs.org/peer/-/peer-1.0.0.tgz)";
  const contents = JSON.stringify({
    packages: {
      [key]: {
        resolution: { tarball: "https://registry.npmjs.org/parent/-/parent-1.0.0.tgz" }
      }
    }
  });
  const result = check(contents, { filePath: "pnpm-lock.yaml" });
  assert.deepEqual(result.violations, []);
  assert.equal(result.sources.find((source) => source.location.endsWith('"<key>"]')).packageName, undefined);
  assert.equal(result.sources.find((source) => source.location.endsWith('"tarball"]')).packageName, "parent");
});

test("ambiguous identities stay unclassified without weakening source-policy enforcement", () => {
  for (const fixture of unclassifiedDependencies.filter((entry) => entry.name.includes("ambiguous package identity"))) {
    const result = check(fixture.contents, { filePath: fixture.file });
    assert.deepEqual(result.violations, [], fixture.name);
    assert.equal(result.sources[0]?.identityUnclassified, true, fixture.name);
    assert.equal(result.dependencyChanges[0]?.reason, "unclassified", fixture.name);
    const privateHost = fixture.contents
      .replaceAll("registry.npmjs.org", "private.example.com")
      .replaceAll("registry.yarnpkg.com", "private.example.com");
    assert.equal(check(privateHost, { filePath: fixture.file }).violations[0]?.reason, "unapproved-host", fixture.name);
  }
});

test("package identity parsing remains bounded on hostile descriptors and peer suffixes", () => {
  const moduleUrl = new URL("../scripts/lockfile-sources.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { validateLockfileChanges } from ${JSON.stringify(moduleUrl)};
    const url = "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz";
    for (const descriptor of ["a".repeat(500000), "pkg@1.0.0" + "(peer@1)".repeat(50000), "alias@npm:".repeat(50000)]) {
      for (const [filePath, headContents] of [
        ["pnpm-lock.yaml", JSON.stringify({ packages: { [descriptor]: { resolution: { tarball: url } } } })],
        ["bun.lock", JSON.stringify({ packages: { pkg: [descriptor, url, {}, "hash"] } })],
        ["yarn.lock", JSON.stringify(descriptor) + ':\\n  resolved "' + url + '"\\n']
      ]) {
        const result = validateLockfileChanges({ filePath, baseContents: null, headContents });
        assert.deepEqual(result.violations, []);
        assert.equal(result.sources[0]?.identityUnclassified, true);
        assert.equal(result.dependencyChanges[0]?.reason, "unclassified");
      }
    }
  `
    ],
    { encoding: "utf8", timeout: 5000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("unmodeled dependency encodings produce explicit non-blocking review records", () => {
  for (const fixture of unclassifiedDependencies) {
    const result = check(fixture.contents, { filePath: fixture.file });
    assert.deepEqual(result.violations, [], fixture.name);
    for (const location of fixture.locations) {
      const entry = result.dependencyChanges.find((change) => change.location === JSON.stringify(location));
      assert.equal(entry?.reason, "unclassified", `${fixture.name}: ${JSON.stringify(location)}`);
    }
  }
});

test("removing resolution fields or hiding behind unrelated URLs cannot suppress dependency changes", () => {
  const resolved = "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz";
  const baseContents = JSON.stringify({
    packages: {
      "node_modules/pkg": { version: "1.0.0", resolved, integrity: "sha512-test" },
      "node_modules/unchanged": { version: "1.0.0" }
    }
  });
  for (const replacement of [{ version: "1.0.0" }, { version: "1.0.0", homepage: resolved }]) {
    const headContents = JSON.stringify({
      packages: {
        "node_modules/pkg": replacement,
        "node_modules/unchanged": { version: "1.0.0" }
      }
    });
    const result = check(headContents, { baseContents });
    assert.deepEqual(result.violations, []);
    assert.equal(result.dependencyChanges.length, 1);
    const [change] = result.dependencyChanges;
    assert.equal(change.packageName, "pkg");
    assert.equal(change.change, "modified");
    assert.equal(change.reason, "unclassified");
    assert.equal(change.before.value.resolved, resolved);
    assert.deepEqual(change.after.value, replacement);
  }
});

test("recognized sources and unclassified siblings both receive changed-entry evidence", () => {
  const base = { packages: { "node_modules/pkg": { resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" } } };
  const head = structuredClone(base);
  head.packages["node_modules/pkg"].resolved = "https://registry.npmjs.org/pkg/-/pkg-2.0.0.tgz";
  head.packages["node_modules/local"] = { resolved: "file:vendor/local.tgz" };
  const result = check(JSON.stringify(head), { baseContents: JSON.stringify(base) });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    result.dependencyChanges.map((entry) => [entry.packageName, entry.reason]),
    [
      ["local", "unclassified"],
      ["pkg", "recognized-source"]
    ]
  );
  const removed = check(JSON.stringify(base), { baseContents: JSON.stringify(head) });
  assert.equal(removed.dependencyChanges.find((entry) => entry.packageName === "local").change, "removed");
});

test("implicit importer replacements and unknown structural fields leave explicit residue", () => {
  const contents = unclassifiedDependencies.find((entry) => entry.name === "pnpm implicit alias").contents;
  const result = check(contents, { filePath: "pnpm-lock.yaml", baseContents: contents.replaceAll("evil", "safe") });
  assert.ok(
    result.dependencyChanges.some((entry) => entry.location === '["importers","."]' && entry.reason === "unclassified")
  );
  const overrideOnly = check(contents.replace("specifier: npm:evil", "specifier: npm:substitute"), {
    filePath: "pnpm-lock.yaml",
    baseContents: contents
  });
  assert.equal(overrideOnly.dependencyChanges.length, 1);
  assert.equal(overrideOnly.dependencyChanges[0].location, '["importers","."]');
  const unknown = check('{"futureDependencyContainer":{"pkg":"attacker/pkg"}}');
  assert.equal(unknown.dependencyChanges[0].reason, "unclassified");
});

test("semantic re-encoding and package-array reordering do not create dependency changes", () => {
  const result = check('{"packages":{"node_modules/pkg":{"integrity":"hash","version":"1"}}}', {
    baseContents: '{ "packages": { "node_modules/pkg": { "version": "1", "integrity": "hash" } } }'
  });
  assert.deepEqual(result.dependencyChanges, []);
  const first = '[[package]]\nname = "first"\nversion = "1"\n';
  const second = '[[package]]\nname = "second"\nversion = "2"\n';
  assert.deepEqual(
    check(second + first, { filePath: "Cargo.lock", baseContents: first + second }).dependencyChanges,
    []
  );
});

test("changing lockfile selectors or format controls cannot hide behind unchanged dependency maps", () => {
  const base = { version: 7, root: "trusted", nodes: { trusted: { inputs: {} }, evil: { inputs: {} } } };
  const result = check(JSON.stringify({ ...base, root: "evil" }), {
    filePath: "flake.lock",
    baseContents: JSON.stringify(base)
  });
  assert.equal(result.dependencyChanges.length, 1);
  assert.equal(result.dependencyChanges[0].location, '["root"]');
  assert.equal(result.dependencyChanges[0].reason, "unclassified");
  const changedFormat = check('{"lockfileVersion":1,"packages":{},"dependencies":{}}', {
    baseContents: '{"lockfileVersion":3,"packages":{},"dependencies":{}}'
  });
  assert.equal(changedFormat.dependencyChanges[0].location, '["lockfileVersion"]');
});

test("moving a lockfile into another package still surfaces its dependency bindings", () => {
  const contents = npmLock("https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz");
  const result = check(contents, {
    filePath: "apps/new/package-lock.json",
    baseFilePath: "apps/old/package-lock.json",
    baseContents: contents
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.dependencyChanges.length, 1);
  assert.equal(result.dependencyChanges[0].file, "apps/new/package-lock.json");
  assert.equal(result.dependencyChanges[0].previousFile, "apps/old/package-lock.json");
});

test("bounded dependency summaries redact secrets and report oversized values without dropping records", () => {
  const token = `ghp_${"a".repeat(25)}`;
  const value = {
    resolved: `https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz?token=${token}#private`,
    note: token,
    [token]: "secret key"
  };
  const result = check(
    JSON.stringify({
      packages: {
        "node_modules/pkg": value,
        "node_modules/large": { resolved: "file:vendor/pkg.tgz", description: "x".repeat(100_000) }
      }
    })
  );
  assert.equal(result.dependencyChanges.length, 2);
  const pkg = result.dependencyChanges.find((entry) => entry.packageName === "pkg");
  assert.doesNotMatch(JSON.stringify(pkg), /ghp_|\?token=|#private/u);
  assert.equal(pkg.after.value.resolved, "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz");
  const large = result.dependencyChanges.find((entry) => entry.packageName === "large");
  assert.equal(large.reason, "unclassified");
  assert.match(large.after.omitted, /read the original patch units/u);
  assert.ok(large.after.bytes > 100_000);
  assert.equal(large.after.value, undefined);
});

test("GitHub archives require the repository allowlist across ecosystems and endpoints", () => {
  const urls = [
    "https://github.com/attacker/evil/archive/123.tar.gz",
    "https://github.com/attacker/evil/releases/download/v1/pkg.tgz",
    "https://api.github.com/repos/attacker/evil/tarball/123",
    "https://api.github.com/repos/attacker/evil/zipball/123",
    "https://codeload.github.com/attacker/evil/tar.gz/123",
    "https://raw.githubusercontent.com/attacker/evil/123/pkg.tgz"
  ];
  for (const url of urls) {
    for (const [filePath, contents] of [
      ["package-lock.json", npmLock(url)],
      ["composer.lock", JSON.stringify({ packages: [{ dist: { url } }] })],
      ["uv.lock", `[[package]]\nname = "pkg"\nsource = { url = ${JSON.stringify(url)} }\n`],
      ["poetry.lock", `[[package]]\nname = "pkg"\n[package.source]\ntype = "url"\nurl = ${JSON.stringify(url)}\n`]
    ]) {
      const options = { filePath, allowedHosts: [new URL(url).hostname] };
      assert.equal(check(contents, options).violations[0]?.reason, "unapproved-source", `${filePath}: ${url}`);
      assert.deepEqual(
        check(contents, { ...options, allowedSources: ["https://github.com/attacker/evil"] }).violations,
        []
      );
      assert.equal(
        check(contents, { ...options, allowedSources: ["https://github.com/trusted/evil"] }).violations.length,
        1
      );
    }
  }
});

test("opaque GitHub assets and ambiguous archive paths cannot inherit repository approval", () => {
  for (const url of [
    "https://objects.githubusercontent.com/github-production-release-asset/123/pkg.tgz",
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/pkg.tgz",
    "https://github.com:8443/trusted/pkg/archive/123.tar.gz",
    "https://api.github.com/repos/trusted/pkg%2Fevil/tarball/123",
    "https://github.com/trusted/pkg/archive/%2e%2e%2fother/pkg.tgz",
    "https://github.com/trusted/pkg-extra/archive/123.tar.gz"
  ]) {
    assert.equal(
      check(npmLock(url), {
        allowedHosts: [new URL(url).hostname],
        allowedSources: ["https://github.com/trusted/pkg"]
      }).violations[0]?.reason,
      "unapproved-source",
      url
    );
  }
});

test("Git source context survives case folding and whitespace normalization on private hosts", () => {
  for (const url of [
    "HTTPS://git.example.com/attacker/pkg.git",
    "https:\n//git.example.com/attacker/pkg.git",
    "//git.example.com/attacker/pkg.git"
  ]) {
    const contents = JSON.stringify({ packages: [{ source: { type: "git", url } }] });
    const options = { filePath: "composer.lock", allowedHosts: ["git.example.com"] };
    assert.equal(check(contents, options).violations[0]?.reason, "unapproved-source");
    assert.deepEqual(
      check(contents, { ...options, allowedSources: ["https://git.example.com/attacker/pkg"] }).violations,
      []
    );
  }
  assert.equal(
    check("GIT\n  remote: HTTPS://github.com/attacker/pkg.git\n", { filePath: "Gemfile.lock" }).violations[0]?.reason,
    "unapproved-source"
  );
  for (const contents of [
    "GIT\r\n  remote: https://git.example.com/attacker/pkg.git\r\n",
    "GIT  \n  remote: https://git.example.com/attacker/pkg.git\n"
  ]) {
    assert.equal(
      check(contents, { filePath: "Gemfile.lock", allowedHosts: ["git.example.com"] }).violations[0]?.reason,
      "unapproved-source"
    );
  }
});

test("base lockfiles grandfather exact bindings, never entire hosts or origins", () => {
  const baseContents = npmLock("https://private.example.com/benign.tgz");
  const headContents = npmLock("https://private.example.com/backdoor.tgz");
  assert.deepEqual(check(baseContents, { baseContents }).sources, []);
  assert.equal(check(headContents, { baseContents }).violations[0]?.reason, "unapproved-host");
  assert.deepEqual(check(headContents, { baseContents, allowedHosts: ["private.example.com"] }).violations, []);
  const gitBase = npmLock("git+https://github.com/trusted/pkg.git#123");
  assert.equal(
    check(npmLock("git+https://github.com/trusted/pkg.git#456"), { baseContents: gitBase }).violations[0]?.reason,
    "unapproved-source"
  );
  const shared = "https://private.example.com/benign.tgz";
  assert.equal(check(npmLock(shared, "different-package"), { baseContents }).violations[0]?.reason, "unapproved-host");
});

test("both npm registry hosts enforce package identity and the standard HTTPS port", () => {
  for (const host of ["registry.npmjs.org", "registry.yarnpkg.com"]) {
    assert.equal(
      check(npmLock(`https://${host}/evil/-/evil-1.0.0.tgz`, "lodash")).violations[0]?.reason,
      "source-identity-mismatch"
    );
    assert.deepEqual(check(npmLock(`https://${host}/lodash/-/lodash-1.0.0.tgz`, "lodash")).violations, []);
    assert.equal(check(npmLock(`https://${host}:8443/pkg/-/pkg-1.0.0.tgz`)).violations[0]?.reason, "unapproved-port");
  }
});

test("public Git SSH usernames are transport identities, not approval or password bypasses", () => {
  const options = { allowedSources: ["https://github.com/trusted/pkg"] };
  for (const url of [
    "git+ssh://git@github.com/trusted/pkg.git#123",
    "git@github.com:trusted/pkg.git#123",
    "ssh://git@github.com/trusted/pkg.git#123"
  ]) {
    assert.deepEqual(check(npmLock(url), options).violations, [], url);
    assert.equal(check(npmLock(url)).violations[0]?.reason, "unapproved-source", url);
  }
  for (const url of [
    "git+ssh://git:password@github.com/trusted/pkg.git",
    "git+ssh://token@github.com/trusted/pkg.git",
    "git+https://git@github.com/trusted/pkg.git"
  ])
    assert.equal(check(npmLock(url), options).violations[0]?.reason, "embedded-credentials", url);
  assert.deepEqual(
    check(npmLock("ssh://git@git.example.com:2222/trusted/pkg.git"), {
      allowedSources: ["https://git.example.com:2222/trusted/pkg"]
    }).violations,
    []
  );
  assert.equal(
    check(npmLock("ssh://git@git.example.com:2222/trusted/pkg.git"), {
      allowedSources: ["https://git.example.com/2222/trusted/pkg"]
    }).violations[0]?.reason,
    "unapproved-source"
  );
});

test("registry approval is narrow and cannot turn into GitHub-wide trust", () => {
  const url = "https://github.com/rust-lang/crates.io-index";
  assert.deepEqual(check(`[[package]]\nsource = "registry+${url}"\n`, { filePath: "Cargo.lock" }).violations, []);
  for (const source of [url, `git+${url}`, "registry+https://github.com/attacker/evil"]) {
    assert.equal(
      check(`[[package]]\nsource = "${source}"\n`, { filePath: "Cargo.lock" }).violations[0]?.reason,
      "unapproved-source"
    );
  }
  assert.deepEqual(
    check(npmLock("https://private.example.com:8443/pkg.tgz"), {
      allowedHosts: ["private.example.com"]
    }).violations,
    []
  );
});

test("GitHub origin checks remain bounded on long hostile URL paths", () => {
  const moduleUrl = new URL("../scripts/lockfile-sources.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { validateLockfileChanges } from ${JSON.stringify(moduleUrl)};
    for (const suffix of ["a".repeat(500000) + "!", "a/".repeat(250000), "%2f".repeat(160000)]) {
      const headContents = JSON.stringify({ packages: { "node_modules/pkg": { resolved: "https://github.com/attacker/" + suffix } } });
      const { violations } = validateLockfileChanges({ filePath: "package-lock.json", baseContents: null, headContents });
      if (violations[0]?.reason !== "unapproved-source") process.exit(1);
    }
  `
    ],
    { encoding: "utf8", timeout: 5000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
