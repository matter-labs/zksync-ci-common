import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeSession } from "../scripts/claude-session.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-launch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, "source with spaces");
  const engineRoot = path.join(sourceDirectory, ".ai-security-review-engine", "ai-security-review");
  const temporaryDirectory = path.join(root, "runner-temp");
  mkdirSync(engineRoot, { recursive: true });
  mkdirSync(temporaryDirectory);
  return { root, sourceDirectory, engineRoot, temporaryDirectory };
}

test("session directories are private, outside the checkout and use absolute exact/subtree denials", (t) => {
  const options = fixture(t);
  const session = createClaudeSession(options);
  assert(session.workingDirectory.startsWith(`${options.temporaryDirectory}/`));
  assert.equal(statSync(session.workingDirectory).mode & 0o777, 0o700);
  const deny = JSON.parse(readFileSync(session.settingsFile, "utf8")).permissions.deny;
  assert.deepEqual(deny, [
    `Read(/${options.sourceDirectory}/.git)`,
    `Read(/${options.sourceDirectory}/.git/**)`,
    `Read(/${path.dirname(options.engineRoot)})`,
    `Read(/${path.dirname(options.engineRoot)}/**)`
  ]);
  assert.notEqual(createClaudeSession(options).workingDirectory, session.workingDirectory);
  assert.throws(
    () => createClaudeSession({ ...options, temporaryDirectory: options.sourceDirectory }),
    /outside the checkout/u
  );
});

test(
  "the pinned Bun launcher ignores PR preloads and dotenv after changing to the isolated session",
  { skip: !process.env.BUN_EXECUTABLE },
  (t) => {
    const options = fixture(t);
    const action = path.join(options.root, "trusted-action");
    mkdirSync(path.join(action, "src"), { recursive: true });
    writeFileSync(
      path.join(action, "src", "index.ts"),
      'console.log(JSON.stringify({envLoaded: process.env.PR_ENV_CANARY === "loaded", keyPreserved: process.env.ANTHROPIC_API_KEY === "dummy-key", oidcPreserved: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "dummy-oidc"}));'
    );
    writeFileSync(path.join(options.sourceDirectory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(path.join(options.sourceDirectory, "preload.ts"), 'console.log("PRELOAD_CANARY");\n');
    writeFileSync(path.join(options.sourceDirectory, ".env"), "PR_ENV_CANARY=loaded\n");
    const version = spawnSync(process.env.BUN_EXECUTABLE, ["--version"], { encoding: "utf8" });
    assert.equal(version.stdout.trim(), "1.3.14");
    const launch = (workingDirectory) =>
      spawnSync(
        "bash",
        [
          "-e",
          "-c",
          'if [ -n "$CLAUDE_WORKING_DIR" ]; then cd "$CLAUDE_WORKING_DIR"; fi\n"$BUN_EXECUTABLE" run "$GITHUB_ACTION_PATH/src/index.ts"'
        ],
        {
          cwd: options.sourceDirectory,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            BUN_EXECUTABLE: process.env.BUN_EXECUTABLE,
            CLAUDE_WORKING_DIR: workingDirectory,
            GITHUB_ACTION_PATH: action,
            ANTHROPIC_API_KEY: "dummy-key",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "dummy-oidc"
          }
        }
      );
    const unsafe = launch("");
    assert.equal(unsafe.status, 0, unsafe.stderr);
    assert.match(unsafe.stdout, /PRELOAD_CANARY/u);
    assert.match(unsafe.stdout, /"envLoaded":true/u);
    const safe = launch(createClaudeSession(options).workingDirectory);
    assert.equal(safe.status, 0, safe.stderr);
    assert.deepEqual(JSON.parse(safe.stdout), { envLoaded: false, keyPreserved: true, oidcPreserved: true });
  }
);
