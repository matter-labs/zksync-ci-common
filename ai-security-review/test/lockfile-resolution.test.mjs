import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateLockfileChanges } from "../scripts/lockfile-sources.mjs";

function check(filePath, headContents, options = {}) {
  return validateLockfileChanges({ filePath, baseContents: null, headContents, ...options });
}

function uvLock(source) {
  return `version = 1\n[[package]]\nname = "pkg"\nversion = "1.0.0"\nsource = ${source}\n`;
}

test("the engine's committed npm lockfile enforces downloads and retains funding metadata as evidence", () => {
  const contents = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
  const result = check("package-lock.json", contents);
  assert.deepEqual(result.violations, []);
  const packages = JSON.parse(contents).packages;
  assert.equal(result.sources.length, Object.values(packages).filter((entry) => entry.resolved).length);
  assert.ok(result.sources.every((source) => source.host === "registry.npmjs.org"));
  for (const name of ["yaml", "smol-toml"]) {
    const change = result.dependencyChanges.find((entry) => entry.packageName === name);
    assert.equal(change.reason, "recognized-source");
    assert.deepEqual(change.after.value.funding, packages[`node_modules/${name}`].funding);
  }
});

test("metadata-only changes need no source approval, including fields misleadingly named url or resolved", () => {
  const base = { packages: { "node_modules/pkg": { resolved: "https://registry.npmjs.org/pkg/-/pkg-1.tgz" } } };
  for (const metadata of [
    { funding: "https://github.com/sponsors/example" },
    { funding: [{ type: "github", url: "https://github.com/sponsors/example" }] },
    { homepage: "https://project.example.com/", bugs: { url: "https://issues.example.com/" } },
    { description: "Download https://docs.example.com/guide for help" },
    { funding: { resolved: 42, source: { git: "https://git.example.com/other/repo" } } },
    { metadata: { "https://metadata.example.com": "https://" } }
  ]) {
    const head = structuredClone(base);
    Object.assign(head.packages["node_modules/pkg"], metadata);
    const result = check("package-lock.json", JSON.stringify(head), { baseContents: JSON.stringify(base) });
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.violations, []);
    assert.equal(result.dependencyChanges.length, 1);
    assert.deepEqual(result.dependencyChanges[0].after.value, head.packages["node_modules/pkg"]);
  }
});

test("funding metadata cannot approve a download, grandfather its URL or classify a missing source", () => {
  const url = "https://downloads.example.com/pkg.tgz";
  const base = { packages: { "node_modules/pkg": { funding: { url } } } };
  const missing = check("package-lock.json", JSON.stringify(base));
  assert.deepEqual(missing.sources, []);
  assert.equal(missing.dependencyChanges[0].reason, "unclassified");
  for (const [resolved, reason] of [
    [url, "unapproved-host"],
    ["https://github.com/attacker/pkg/archive/main.tgz", "unapproved-source"],
    ["http://registry.npmjs.org/pkg/-/pkg.tgz", "insecure-protocol"],
    ["https://user:pass@registry.npmjs.org/pkg/-/pkg.tgz", "embedded-credentials"],
    ["https://registry.npmjs.org/other/-/other.tgz", "source-identity-mismatch"]
  ]) {
    const head = structuredClone(base);
    head.packages["node_modules/pkg"].resolved = resolved;
    assert.equal(
      check("package-lock.json", JSON.stringify(head), { baseContents: JSON.stringify(base) }).violations[0]?.reason,
      reason
    );
  }
});

test("uv Git sources require the exact repository approval even on approved hosts", () => {
  const origin = "https://git.example.com/trusted/pkg";
  for (const url of [
    `${origin}.git?rev=main#${"a".repeat(40)}`,
    `${origin.toUpperCase().replace("TRUSTED/PKG", "trusted/pkg")}.git/`,
    "https:\n//git.example.com/trusted/pkg.git",
    "//git.example.com/trusted/pkg.git",
    "git+https://git.example.com/trusted/pkg.git",
    "ssh://git@git.example.com/trusted/pkg.git",
    "git@git.example.com:trusted/pkg.git"
  ]) {
    const contents = uvLock(`{ git = ${JSON.stringify(url)} }`);
    const hostOnly = check("uv.lock", contents, { allowedHosts: ["git.example.com"] });
    assert.equal(hostOnly.sources[0]?.kind, "git", url);
    assert.equal(hostOnly.violations[0]?.reason, "unapproved-source", url);
    assert.deepEqual(check("uv.lock", contents, { allowedSources: [origin] }).violations, [], url);
    assert.equal(
      check("uv.lock", contents, { allowedHosts: ["git.example.com"], allowedSources: [`${origin}-other`] })
        .violations[0]?.reason,
      "unapproved-source",
      url
    );
  }
});

test("uv Git classification preserves protocol and credential failures and rechecks changed revisions", () => {
  const origin = "https://git.example.com/trusted/pkg";
  for (const [url, reason] of [
    ["http://git.example.com/trusted/pkg", "insecure-protocol"],
    ["git://git.example.com/trusted/pkg", "insecure-protocol"],
    ["https://user:pass@git.example.com/trusted/pkg", "embedded-credentials"],
    ["git+ssh://git:pass@git.example.com/trusted/pkg", "embedded-credentials"]
  ]) {
    const result = check("uv.lock", uvLock(`{ git = ${JSON.stringify(url)} }`), {
      allowedHosts: ["git.example.com"],
      allowedSources: [origin]
    });
    assert.equal(result.violations[0]?.reason, reason);
  }
  const baseContents = uvLock(`{ git = "${origin}.git#111" }`);
  const headContents = uvLock(`{ git = "${origin}.git#222" }`);
  assert.deepEqual(check("uv.lock", baseContents, { baseContents }).sources, []);
  assert.equal(check("uv.lock", headContents, { baseContents }).violations[0]?.reason, "unapproved-source");
  assert.deepEqual(check("uv.lock", headContents, { baseContents, allowedSources: [origin] }).violations, []);
  assert.equal(
    check("uv.lock", headContents, {
      baseContents: uvLock(`{ url = "${origin}.git#222" }`),
      allowedHosts: ["git.example.com"]
    }).violations[0]?.reason,
    "unapproved-source"
  );
  assert.deepEqual(check("uv.lock", uvLock('{ registry = "https://pypi.org/simple" }')).violations, []);
  assert.equal(
    check("uv.lock", uvLock('{ git = "registry+https://github.com/rust-lang/crates.io-index" }')).violations[0]?.reason,
    "unapproved-source"
  );
});

test("metadata stays outside enforcement across parsed ecosystems while actual sources remain enforced", () => {
  const url = "https://unknown.example.com/pkg.tgz";
  const metadata = { funding: { url }, homepage: url };
  for (const [file, clean, unsafe] of [
    [
      "composer.lock",
      { packages: [{ name: "pkg", ...metadata }] },
      { packages: [{ name: "pkg", ...metadata, dist: { url } }] }
    ],
    ["flake.lock", { nodes: { pkg: metadata } }, { nodes: { pkg: { ...metadata, locked: { url } } } }],
    [
      "pnpm-lock.yaml",
      { packages: { pkg: metadata } },
      { packages: { pkg: { ...metadata, resolution: { tarball: url } } } }
    ],
    ["bun.lock", { packages: { pkg: ["pkg@1", "", metadata] } }, { packages: { pkg: ["pkg@1", url, metadata] } }]
  ]) {
    assert.deepEqual(check(file, JSON.stringify(clean)).sources, [], file);
    assert.equal(check(file, JSON.stringify(unsafe)).violations[0]?.reason, "unapproved-host", file);
  }
  for (const file of ["Cargo.lock", "poetry.lock", "uv.lock"]) {
    const contents = `[[package]]\nname = "pkg"\nhomepage = "${url}"\n[package.funding]\nurl = "${url}"\n`;
    assert.deepEqual(check(file, contents).sources, [], file);
    assert.equal(check(file, contents).dependencyChanges[0]?.reason, "unclassified", file);
  }
  assert.deepEqual(check("yarn.lock", `__metadata:\n  version: 8\n"pkg@npm:1":\n  homepage: "${url}"\n`).sources, []);
});

test("resolution locators in keys, legacy dependency maps, importers and artifact URLs remain enforced", () => {
  const url = "https://unknown.example.com/pkg.tgz";
  for (const [file, contents] of [
    ["package-lock.json", JSON.stringify({ dependencies: { parent: { dependencies: { child: { version: url } } } } })],
    ["package-lock.json", JSON.stringify({ packages: { "node_modules/funding": { resolved: url } } })],
    ["package-lock.json", JSON.stringify({ packages: { "": { dependencies: { pkg: url } } } })],
    ["pnpm-lock.yaml", JSON.stringify({ packages: { [url]: { resolution: { integrity: "hash" } } } })],
    ["pnpm-lock.yaml", JSON.stringify({ importers: { ".": { dependencies: { pkg: { version: url } } } } })],
    ["yarn.lock", `__metadata:\n  version: 8\n"pkg@${url}":\n  version: 1\n`],
    ["bun.lock", JSON.stringify({ packages: { pkg: [`pkg@${url}`, "", {}] } })],
    ["uv.lock", `${uvLock('{ registry = "https://pypi.org/simple" }')}sdist = { url = "${url}" }\n`],
    ["uv.lock", `${uvLock('{ registry = "https://pypi.org/simple" }')}wheels = [{ url = "${url}" }]\n`]
  ])
    assert.equal(check(file, contents).violations[0]?.reason, "unapproved-host", file);
});
