import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../../.github/workflows/ai-security-review.yaml", import.meta.url), "utf8")
);

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cli-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  mkdirSync(path.join(source, "package"), { recursive: true });
  const contents = "#!/bin/sh\nexit 0\n";
  writeFileSync(path.join(source, "package", "claude"), contents, { mode: 0o755 });
  const archive = path.join(root, "claude-code.tgz");
  execFileSync("tar", ["-czf", archive, "-C", source, "package"]);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  const executable = path.join(root, "extracted", "package", "claude");
  return { root, archive, integrity, executable, contents };
}

for (const name of ["review", "verify"]) {
  const restore = workflow.jobs[name].steps.find((step) => step.name === "Verify and extract Claude CLI");

  function run(f, integrity = f.integrity) {
    assert.ok(restore, `${name}: missing CLI verification`);
    return spawnSync("bash", ["-c", restore.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_DIRECTORY: f.root,
        CLAUDE_EXECUTABLE: f.executable,
        CLAUDE_CLI_INTEGRITY: integrity
      }
    });
  }

  test(`${name} restores the pinned archive with executable permissions`, (t) => {
    const f = fixture(t);
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.executable, "utf8"), f.contents);
    assert.ok(statSync(f.executable).mode & 0o100);
  });

  test(`${name} rejects altered archive bytes before extraction`, (t) => {
    const f = fixture(t);
    appendFileSync(f.archive, "tampered");
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Claude CLI integrity mismatch/u);
    assert.equal(existsSync(path.join(f.root, "extracted")), false);
  });

  test(`${name} rejects a different expected integrity before extraction`, (t) => {
    const f = fixture(t);
    const result = run(f, `sha512-${Buffer.alloc(64).toString("base64")}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Claude CLI integrity mismatch/u);
    assert.equal(existsSync(path.join(f.root, "extracted")), false);
  });
}
