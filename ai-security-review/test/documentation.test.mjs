import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validateRepositoryConfig } from "../scripts/repository-config.mjs";
import { profilesForPath } from "../scripts/profiles.mjs";

const engineRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.name.endsWith(".md") ? [file] : [];
  });
}

function proseLines(text) {
  let fence = null;
  return text.split("\n").filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      return false;
    }
    if (marker) {
      fence = marker;
      return false;
    }
    return true;
  });
}

function withoutInlineCode(line) {
  let result = "";
  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf("`", cursor);
    if (start === -1) return result + line.slice(cursor);
    let markerEnd = start + 1;
    while (line[markerEnd] === "`") markerEnd += 1;
    const delimiter = line.slice(start, markerEnd);
    const end = line.indexOf(delimiter, markerEnd);
    if (end === -1) return result + line.slice(cursor);
    result += line.slice(cursor, start);
    cursor = end + delimiter.length;
  }
  return result;
}

function anchors(text) {
  const found = new Set();
  const suffixes = new Map();
  for (const line of proseLines(text)) {
    const heading = /^ {0,3}#{1,6} (.+)$/u.exec(line)?.[1];
    if (!heading) continue;
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replaceAll(" ", "-");
    let name = slug;
    let suffix = suffixes.get(slug) ?? 0;
    while (found.has(name)) name = `${slug}-${++suffix}`;
    suffixes.set(slug, suffix);
    found.add(name);
  }
  return found;
}

function links(text) {
  const found = [];
  for (const rawLine of proseLines(text)) {
    const line = withoutInlineCode(rawLine);
    const reference = /^ {0,3}\[[^\]]+\]:\s*(\S+)/u.exec(line)?.[1];
    if (reference) found.push(reference);
    let cursor = 0;
    while (cursor < line.length) {
      const start = line.indexOf("](", cursor);
      if (start === -1) break;
      const end = line.indexOf(")", start + 2);
      assert.notEqual(end, -1, `Unclosed documentation link: ${rawLine}`);
      found.push(line.slice(start + 2, end));
      cursor = end + 1;
    }
  }
  return found;
}

function checkLink(file, href) {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("//")) return;
  const [pathname, fragment] = href.split("#");
  const decodedPath = decodeURIComponent(pathname.split("?")[0]);
  const target = !decodedPath
    ? file
    : decodedPath.startsWith("/")
      ? path.join(repositoryRoot, decodedPath.slice(1))
      : path.resolve(path.dirname(file), decodedPath);
  const relative = path.relative(repositoryRoot, target);
  assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`), `Link leaves repository: ${href}`);
  assert.ok(existsSync(target), `Missing target in ${file}: ${href}`);
  if (!fragment) return;
  assert.ok(statSync(target).isFile(), `Anchor requires a file: ${href}`);
  const content = readFileSync(target, "utf8");
  if (target.endsWith(".md")) {
    assert.ok(anchors(content).has(decodeURIComponent(fragment)), `Missing anchor in ${file}: ${href}`);
  } else {
    const lines = /^L(\d+)(?:-L(\d+))?$/u.exec(fragment);
    assert.ok(lines, `Unsupported file fragment: ${href}`);
    assert.ok(Number(lines[1]) >= 1 && Number(lines[2] ?? lines[1]) <= content.split("\n").length, href);
  }
}

function tableValues(text, heading) {
  const section = text.split(`## ${heading}\n`)[1]?.split("\n## ")[0];
  assert.ok(section, `Missing ${heading} section`);
  const values = {};
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (!cells[0].startsWith("`")) continue;
    assert.ok(cells[0].endsWith("`") && cells[1].startsWith("`") && cells[1].endsWith("`"), line);
    const key = cells[0].slice(1, -1);
    assert.ok(!Object.hasOwn(values, key), `Duplicate documented setting: ${key}`);
    values[key] = cells[1].slice(1, -1);
  }
  return values;
}

test("all engine documentation relative links and heading anchors resolve", () => {
  for (const file of [...markdownFiles(engineRoot), path.join(repositoryRoot, "README.md")]) {
    for (const href of links(readFileSync(file, "utf8"))) checkLink(file, href);
  }
});

test("documentation link checks ignore code examples and reject missing files or anchors", () => {
  const sample = [
    "# Read `CLEAN` Results",
    "# Read `CLEAN` Results",
    "```markdown",
    "# Not a Heading",
    "[example](missing.md)",
    "```",
    "`[example](also-missing.md)` [real](README.md)",
    "[guide]: docs/results.md#read-the-comment"
  ].join("\n");
  assert.deepEqual([...anchors(sample)], ["read-clean-results", "read-clean-results-1"]);
  assert.deepEqual(links(sample), ["README.md", "docs/results.md#read-the-comment"]);
  const readme = path.join(engineRoot, "README.md");
  assert.throws(() => checkLink(readme, "does-not-exist.md"), /Missing target/u);
  assert.throws(() => checkLink(readme, "README.md#does-not-exist"), /Missing anchor/u);
  assert.throws(() => checkLink(readme, "../../../outside.md"), /leaves repository/u);
});

test("documented central settings and caller defaults match the reusable workflow", () => {
  const workflow = parse(readFileSync(path.join(repositoryRoot, ".github/workflows/ai-security-review.yaml"), "utf8"));
  const configuration = readFileSync(path.join(engineRoot, "docs/configuration.md"), "utf8");
  const pairedOrForwarded = new Set(["CLAUDE_CLI_URL", "CLAUDE_CLI_INTEGRITY", "AI_SECURITY_REVIEW_MAXIMUM_BATCHES"]);
  const env = Object.fromEntries(
    Object.entries(workflow.env)
      .filter(([key]) => !pairedOrForwarded.has(key))
      .map(([key, value]) => [key, String(value)])
  );
  assert.deepEqual(tableValues(configuration, "Central Settings"), env);
  const inputs = Object.fromEntries(
    Object.entries(workflow.on.workflow_call.inputs).map(([key, value]) => [key, String(value.default)])
  );
  assert.deepEqual(tableValues(configuration, "Caller Inputs"), inputs);
});

test("documented configuration examples validate and focus files match their routing example", () => {
  const profilesRoot = path.join(engineRoot, "profiles");
  for (const file of ["README.md", "docs/configuration.md"]) {
    const text = readFileSync(path.join(engineRoot, file), "utf8");
    for (const block of text.split("```json\n").slice(1)) {
      validateRepositoryConfig(JSON.parse(block.split("\n```")[0]), profilesRoot);
    }
  }
  const configuration = readFileSync(path.join(engineRoot, "docs/configuration.md"), "utf8");
  const config = validateRepositoryConfig(
    JSON.parse(configuration.split("```json\n")[1].split("\n```")[0]),
    profilesRoot
  );
  assert.deepEqual(config.context, [".github/security-review-focus-main.md", ".github/security-review-focus-ci.md"]);
  for (const file of [
    ".github/workflows/build.yaml",
    "deployments/service.yaml",
    "Dockerfile",
    "apps/web/Dockerfile.release"
  ]) {
    assert.ok(profilesForPath(file, config).includes("domains/privileged-automation"), file);
  }
  assert.ok(!profilesForPath("src/application.ts", config).includes("domains/privileged-automation"));
  for (const sample of ["app.md", "ci.md"]) {
    assert.ok(readFileSync(path.join(engineRoot, "examples/focus", sample), "utf8").startsWith("Applies to "));
  }
});
