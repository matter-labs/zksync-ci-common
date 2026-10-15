import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readLockfileSources, validateLockfileChanges } from "../scripts/lockfile-sources.mjs";

function check(headContents, overrides = {}) {
  return validateLockfileChanges({ filePath: "package-lock.json", baseContents: null, headContents, ...overrides });
}

function npmLock(resolved, name = "pkg", extra = {}) {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { [`node_modules/${name}`]: { version: "1.0.0", resolved, ...extra } }
  });
}

test("TOML parsing stays bounded on many dot-free keys", () => {
  const parser = import.meta.resolve("smol-toml");
  const source = `
    import { parse } from ${JSON.stringify(parser)};
    const input = Array.from({ length: 300000 }, (_, index) => "k" + index + " = 1").join("\\n");
    const result = parse(input);
    if (Object.keys(result).length !== 300000) process.exit(1);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("JSON Unicode escapes cannot hide a host, protocol, credentials or package identity", () => {
  for (const [url, reason] of [
    ["https://unknown.example.invalid/pkg.tgz", "unapproved-host"],
    ["http://registry.npmjs.org/pkg/-/pkg.tgz", "insecure-protocol"],
    ["https://user:pass@registry.npmjs.org/pkg/-/pkg.tgz", "embedded-credentials"],
    ["https://registry.npmjs.org/other/-/other.tgz", "source-identity-mismatch"],
    ["git+https://github.com/unknown/repo.git", "unapproved-source"]
  ]) {
    for (const encode of [
      (value) => value.replaceAll("/", "\\u002f"),
      (value) => value.replaceAll("/", "\\/"),
      (value) => [...value].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")
    ]) {
      const contents = `{"packages":{"node_modules/pkg":{"resolved":"${encode(url)}"}}}`;
      assert.equal(check(contents).violations[0]?.reason, reason, contents);
    }
  }
});

test("decoded base/head records preserve existing sources but recheck new package bindings", () => {
  const base = npmLock("https://private.example/pkg.tgz");
  const reencoded = base.replaceAll("/", "\\u002f");
  assert.deepEqual(check(reencoded, { baseContents: base }).sources, []);
  assert.equal(
    check(npmLock("https://private.example/new.tgz"), { baseContents: reencoded }).violations[0]?.reason,
    "unapproved-host"
  );
  const shared = "https://registry.npmjs.org/other/-/other.tgz";
  assert.equal(
    check(npmLock(shared), { baseContents: npmLock(shared, "other") }).violations[0]?.reason,
    "source-identity-mismatch"
  );
  assert.deepEqual(check(null, { baseContents: base }).sources, []);
  assert.equal(
    check(npmLock("https://private.example/pkg.tgz"), {
      baseFilePath: "pnpm-lock.yaml",
      baseContents: 'packages:\n  pkg:\n    resolution: { tarball: "https://private.example/pkg.tgz" }\n'
    }).violations[0]?.reason,
    "unapproved-host"
  );
});

test("npm aliases, scoped and nested packages, local dependencies and legacy lockfiles retain their identities", () => {
  const url = "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz";
  const alias = JSON.stringify({
    packages: {
      "": { dependencies: { alias: "npm:@scope/pkg@1.0.0" } },
      "node_modules/alias": { name: "@scope/pkg", resolved: url },
      "node_modules/local": { resolved: "file:../local", link: true },
      "node_modules/parent/node_modules/@scope/pkg": { resolved: url }
    }
  });
  assert.deepEqual(check(alias).violations, []);
  for (const local of ["file:///tmp/pkg.tgz", "link:../pkg", "workspace:packages/pkg", "portal:../pkg"]) {
    assert.deepEqual(check(npmLock(local)).sources, []);
  }
  assert.equal(check(npmLock(url, "alias", { name: "@scope/pkg" })).violations[0]?.reason, "source-identity-mismatch");
  assert.deepEqual(
    check(JSON.stringify({ lockfileVersion: 1, dependencies: { "@scope/pkg": { resolved: url } } })).violations,
    []
  );
  assert.equal(
    check(JSON.stringify({ lockfileVersion: 1, dependencies: { pkg: { resolved: url } } })).violations[0]?.reason,
    "source-identity-mismatch"
  );
});

test("YAML, TOML, JSONC and Yarn decode escaped sources before policy checks", () => {
  const escaped = String.raw`https:\u002f\u002funknown.example.invalid/pkg.tgz`;
  for (const [filePath, contents] of [
    ["pnpm-lock.yaml", `lockfileVersion: '9.0'\npackages:\n  pkg@1.0.0:\n    resolution: {tarball: "${escaped}"}\n`],
    ["Cargo.lock", `[[package]]\nname = "pkg"\nsource = "${escaped}"\n`],
    ["poetry.lock", `[[package]]\nname = "pkg"\n[package.source]\nurl = "${escaped}"\n`],
    ["uv.lock", `[[package]]\nname = "pkg"\nsource = { url = "${escaped}" }\n`],
    ["bun.lock", `{// comment\n"packages": {"pkg": ["pkg@1.0.0", "${escaped}"],},}`],
    ["yarn.lock", `# yarn lockfile v1\n\npkg@^1.0.0:\n  version "1.0.0"\n  resolved "${escaped}"\n`],
    ["yarn.lock", `pkg@^1.0.0:\n  version "1.0.0"\n  resolved "${escaped}"\n`],
    ["yarn.lock", `__metadata:\n  version: 8\n"pkg@npm:1.0.0":\n  resolution: "pkg@${escaped}"\n`],
    ["composer.lock", `{"packages":[{"dist":{"url":"${escaped}"}}]}`],
    ["flake.lock", `{"nodes":{"pkg":{"locked":{"type":"tarball","url":"${escaped}"}}}}`]
  ]) {
    assert.equal(check(contents, { filePath }).violations[0]?.reason, "unapproved-host", filePath);
  }
});

test("registry and Git source policies apply to decoded TOML, Composer and Bundler sources", () => {
  assert.deepEqual(
    check('[[package]]\nsource = "registry+https://github.com/rust-lang/crates.io-index"', { filePath: "Cargo.lock" })
      .violations,
    []
  );
  assert.equal(
    check("GIT\n  remote: https://github.com/unknown/repo.git\n", { filePath: "Gemfile.lock" }).violations[0]?.reason,
    "unapproved-source"
  );
  assert.equal(
    check('{"packages":[{"source":{"type":"git","url":"https://github.com/unknown/repo.git"}}]}', {
      filePath: "composer.lock"
    }).violations[0]?.reason,
    "unapproved-source"
  );
  assert.deepEqual(check("GEM\n  remote: https://rubygems.org/\n", { filePath: "Gemfile.lock" }).violations, []);
  assert.deepEqual(check("example.org/pkg v1.0.0 h1:abcdef=\n", { filePath: "go.sum" }).violations, []);
  assert.deepEqual(
    check(npmLock("git+https://github.com/example/pkg.git?rev=2"), {
      allowedSources: ["https://github.com/example/pkg.git/"]
    }).violations,
    []
  );
});

test("unsupported, malformed and ambiguous structures fail closed without a text fallback", () => {
  for (const [filePath, contents] of [
    ["package-lock.json", '{"packages":'],
    ["package-lock.json", "[]"],
    ["package-lock.json", '{"packages":{"node_modules/pkg":{"resolved":42}}}'],
    ["package-lock.json", '{"packages":{"/":{"dependencies":{"pkg":"1"}}}}'],
    ["pnpm-lock.yaml", "resolution: a\nresolution: b"],
    ["pnpm-lock.yaml", "resolution: !unknown https://example.org"],
    ["pnpm-lock.yaml", "a: &a [*a]"],
    ["Cargo.lock", 'source = "\\invalid"'],
    ["bun.lock", '{"packages":'],
    ["bun.lockb", "unsupported"],
    ["unknown.lock", "https://example.org"]
  ])
    assert.throws(() => readLockfileSources(filePath, contents), undefined, filePath);
});

test("URL normalization checks uppercase protocols, folded values and protocol-relative hosts", () => {
  for (const url of [
    "HTTPS://unknown.example.invalid/pkg.tgz",
    "https:\n//unknown.example.invalid/pkg.tgz",
    "//unknown.example.invalid/pkg.tgz",
    "https:\\unknown.example.invalid\\pkg.tgz"
  ]) {
    assert.equal(check(npmLock(url)).violations[0]?.reason, "unapproved-host", url);
  }
  assert.throws(() => check(npmLock("https://")), /invalid lockfile source URL/u);
});

test("source scanning remains bounded on hostile scheme-like strings", () => {
  const moduleUrl = new URL("../scripts/lockfile-sources.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { readLockfileSources } from ${JSON.stringify(moduleUrl)};
    for (const value of ['a-'.repeat(500000), 'registry+'.repeat(100000), '@'.repeat(1000000), 'a'.repeat(1000000) + ':']) {
      const sources = readLockfileSources('package-lock.json', JSON.stringify({ packages: { 'node_modules/pkg': { resolved: value } } }));
      if (sources.length) process.exit(1);
    }
  `
    ],
    { encoding: "utf8", timeout: 5000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
