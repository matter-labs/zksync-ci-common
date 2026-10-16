import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function directory(value) {
  const resolved = realpathSync(value);
  assert(statSync(resolved).isDirectory(), "Claude paths must be directories");
  assert(!/[\r\n"'\\*?()[\]{}]/u.test(resolved), "unsupported character in Claude directory");
  return resolved;
}

export function createClaudeSession({ sourceDirectory, engineRoot, temporaryDirectory }) {
  const source = directory(sourceDirectory);
  const engine = directory(path.resolve(engineRoot, ".."));
  const temporary = directory(temporaryDirectory);
  assert(temporary !== source && !temporary.startsWith(`${source}/`), "Claude session must be outside the checkout");
  const workingDirectory = mkdtempSync(path.join(temporary, "ai-security-review-session-"));
  const settingsFile = path.join(workingDirectory, "settings.json");
  const deniedPaths = [path.join(source, ".git"), engine];
  const settings = {
    env: { DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" },
    permissions: { deny: deniedPaths.flatMap((entry) => [`Read(/${entry})`, `Read(/${entry}/**)`]) }
  };
  writeFileSync(settingsFile, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
  return { workingDirectory, settingsFile, sourceDirectory: source };
}
