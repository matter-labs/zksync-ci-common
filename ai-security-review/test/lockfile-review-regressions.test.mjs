import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateLockfileChanges } from "../scripts/lockfile-sources.mjs";
import { isLockfilePath } from "../scripts/repository-paths.mjs";
import { buildFinalResult } from "../scripts/review-results.mjs";
import { renderComment } from "../scripts/rendering.mjs";

function check(filePath, headContents, options = {}) {
  return validateLockfileChanges({ filePath, headContents, baseContents: null, ...options });
}

const npmLock = (url) => JSON.stringify({ packages: { "node_modules/pkg": { resolved: url } } });

test("duplicate JSON keys fail closed, including nested and escaped keys in Bun JSONC", () => {
  for (const file of ["package-lock.json", "npm-shrinkwrap.json", "bun.lock", "composer.lock", "flake.lock"]) {
    for (const text of [
      '{"packages":{"pkg":["pkg@1","https://evil.example/pkg"]},"packages":{}}',
      '{"packages":{},"packa\\u0067es":{}}',
      '{"packages":{"node_modules/pkg":{"resolved":"https://evil.example/pkg","resolved":"https://registry.npmjs.org/pkg/-/pkg.tgz"}}}'
    ])
      assert.throws(() => check(file, text, { baseContents: "{}" }), /invalid or unsupported/u, file);
  }
  assert.doesNotThrow(() => check("bun.lock", '{/* comment */"workspaces":{},"packages":{},}'));
  assert.throws(() => check("package-lock.json", '{/* comment */"packages":{},}'), /invalid or unsupported/u);
  assert.doesNotThrow(() => check("bun.lock", '{"packages":{},"other":{"packages":{}}}'));
  assert.throws(() => check("bun.lock", '{"a":'.repeat(101) + "0" + "}".repeat(101)), /invalid or unsupported/u);
});

test("alternate npm and Bundler filenames use the full reader and retain changed dependency context", () => {
  for (const [file, contents, reason] of [
    ["nested/npm-shrinkwrap.json", npmLock("https://evil.example/pkg"), "unapproved-host"],
    ["nested/gems.locked", "GIT\n  remote: https://git.example/pkg/repo.git\n", "unapproved-source"]
  ]) {
    assert.equal(isLockfilePath(file), true);
    const result = check(file, contents);
    assert.equal(result.violations[0]?.reason, reason);
    assert.ok(result.dependencyChanges.length > 0);
    assert.deepEqual(check(file, contents, { baseContents: contents }).sources, []);
  }
  assert.equal(
    check("npm-shrinkwrap.json", npmLock("https://registry.npmjs.org/other/-/other.tgz")).violations[0]?.reason,
    "source-identity-mismatch"
  );
});

test("a lockfile-only alias substitution retains a human-review notice after a clean AI result", () => {
  const lock = (target, version = "1.0.0", alias = true) =>
    JSON.stringify({
      packages: {
        "node_modules/parent": {
          resolved: "https://registry.npmjs.org/parent/-/parent-1.tgz",
          dependencies: { pkg: alias ? `npm:${target}@${version}` : version }
        },
        "node_modules/pkg": { resolved: `https://registry.npmjs.org/${target}/-/${target}-${version}.tgz` }
      }
    });
  const base = lock("pkg", "1.0.0", false);
  const head = lock("other");
  const result = check("package-lock.json", head, { baseContents: base });
  assert.deepEqual(result.violations, []);
  const change = result.dependencyChanges.find((entry) => entry.reviewNotice === "alias-target-change");
  assert.equal(change?.reason, "unclassified");
  assert.equal(change?.packageName, "parent");
  const final = buildFinalResult(
    { units: [], eligibleFiles: [], skippedFiles: [], dependencyChanges: result.dependencyChanges },
    { candidates: [], duplicates: 0 },
    new Map()
  );
  assert.match(renderComment(final), /Human review is required/u);
  assert.ok(
    check("package-lock.json", lock("third"), { baseContents: head }).dependencyChanges.some(
      (entry) => entry.reviewNotice
    )
  );
  assert.ok(
    check("package-lock.json", base, { baseContents: head }).dependencyChanges.some((entry) => entry.reviewNotice)
  );
  assert.ok(
    check("package-lock.json", lock("other", "2.0.0"), { baseContents: head }).dependencyChanges.every(
      (entry) => !entry.reviewNotice
    )
  );
});

test("npm hosted Git references require exact origins; archive suffixes do not define Git semantics", () => {
  for (const url of [
    "https://gitlab.com/org/pkg#abc",
    "gitlab:org/pkg#abc",
    "git+https://gitlab.com/org/pkg.git#abc",
    "git@gitlab.com:org/pkg.git#abc"
  ]) {
    const head = npmLock(url);
    const options = { allowedHosts: ["gitlab.com"] };
    assert.equal(check("package-lock.json", head, options).violations[0]?.reason, "unapproved-source", url);
    assert.deepEqual(
      check("package-lock.json", head, { ...options, allowedSources: ["https://gitlab.com/org/pkg"] }).violations,
      [],
      url
    );
  }
  for (const url of ["github:org/pkg#abc", "org/pkg#abc", "bitbucket:org/pkg#abc"]) {
    assert.equal(check("package-lock.json", npmLock(url)).violations[0]?.reason, "unapproved-source", url);
  }
  assert.deepEqual(
    check("package-lock.json", npmLock("https://archive.example/pkg.git#abc"), { allowedHosts: ["archive.example"] })
      .violations,
    []
  );
  for (const [url, reason] of [
    ["https://user:pass@gitlab.com/org/pkg", "embedded-credentials"],
    ["http://gitlab.com/org/pkg", "insecure-protocol"],
    ["https://gitlab.com:8443/org/pkg", "unapproved-source"],
    ["https://gitlab.com/org/p%6bg", "unapproved-source"]
  ])
    assert.equal(
      check("package-lock.json", npmLock(url), { allowedSources: ["https://gitlab.com/org/pkg"] }).violations[0]
        ?.reason,
      reason,
      url
    );
});

test("Composer checks source and dist mirrors with inherited transport and rejects unsupported mirrors", () => {
  for (const field of ["source", "dist"]) {
    const lock = (mirror, type = field === "source" ? "git" : "zip") =>
      JSON.stringify({
        packages: [
          {
            name: "vendor/pkg",
            version: "1",
            [field]: {
              type,
              url: "https://approved.example/org/pkg",
              reference: "abc",
              mirrors: [{ url: mirror, preferred: true }]
            }
          }
        ]
      });
    const approvals = { allowedHosts: ["approved.example"], allowedSources: ["https://approved.example/org/pkg"] };
    assert.equal(
      check("composer.lock", lock("https://evil.example/org/pkg"), approvals).violations[0]?.reason,
      field === "source" ? "unapproved-source" : "unapproved-host"
    );
    assert.deepEqual(check("composer.lock", lock("https://approved.example/org/pkg"), approvals).violations, []);
    for (const url of [
      "https://approved.example/%reference%",
      "file://approved.example/pkg",
      "custom://approved.example/pkg",
      "relative/pkg"
    ]) {
      assert.throws(() => check("composer.lock", lock(url), approvals), undefined, url);
    }
    assert.throws(
      () => check("composer.lock", lock("https://user:private-value@"), approvals),
      (error) => !error.message.includes("private-value")
    );
    assert.equal(
      check("composer.lock", lock("https://approved.example/evil/pkg", "git"), approvals).violations[0]?.reason,
      "unapproved-source"
    );
  }
});

test("revision and package identity changes recheck sources while array reordering does not", () => {
  const origin = "https://git.example/org/pkg";
  for (const file of ["composer.lock", "poetry.lock"]) {
    for (const revisionField of ["reference", "resolved_reference"]) {
      const lock = (revision, name = "pkg") =>
        file === "composer.lock"
          ? JSON.stringify({
              packages: [{ name, version: "1", source: { type: "git", url: origin, [revisionField]: revision } }]
            })
          : `[[package]]\nname = "${name}"\nversion = "1"\n[package.source]\ntype = "git"\nurl = "${origin}"\n${revisionField} = "${revision}"\n`;
      const baseContents = lock("abc");
      assert.deepEqual(check(file, baseContents, { baseContents }).sources, []);
      assert.equal(check(file, lock("def"), { baseContents }).violations[0]?.reason, "unapproved-source");
      assert.equal(check(file, lock("abc", "other"), { baseContents }).violations[0]?.reason, "unapproved-source");
      assert.deepEqual(check(file, lock("def"), { baseContents, allowedSources: [origin] }).violations, []);
    }
  }
  const packages = ["one", "two"].map((name) => ({
    name,
    version: "1",
    source: { type: "git", url: `${origin}/${name}`, reference: "abc" }
  }));
  assert.deepEqual(
    check("composer.lock", JSON.stringify({ packages: [...packages].reverse() }), {
      baseContents: JSON.stringify({ packages })
    }).sources,
    []
  );
});

test("new lockfile readers bound hostile descriptors and deeply nested JSON without regex stalls", () => {
  const source = `
    import assert from "node:assert/strict";
    import { validateLockfileChanges } from ${JSON.stringify(new URL("../scripts/lockfile-sources.mjs", import.meta.url).href)};
    const check = headContents => validateLockfileChanges({ filePath: "bun.lock", baseContents: null, headContents });
    for (const value of ["gitlab:" + "a/".repeat(250000), "https://gitlab.com/" + "a/".repeat(250000)]) {
      assert.throws(() => check(JSON.stringify({ packages: { pkg: ["pkg@1", value] } })), /validation limits/);
    }
    assert.throws(() => check('{"a":'.repeat(10000) + '0' + '}'.repeat(10000)), /unsupported/);
    check(JSON.stringify({ packages: { pkg: ["pkg@1", "", { dependencies: { alias: "npm:" + "a".repeat(500000) } }] } }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
});
