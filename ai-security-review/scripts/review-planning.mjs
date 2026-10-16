import path from "node:path";
import { compareStrings } from "./ordering.mjs";
import { assert } from "./assert.mjs";
import { MAX_BATCH_UNITS } from "./review-contract.mjs";

const MANIFEST_FILES = new Set([
  "Cargo.toml",
  "CMakeLists.txt",
  "Chart.yaml",
  "Gemfile",
  "Pulumi.yaml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "deno.json",
  "foundry.toml",
  "go.mod",
  "hardhat.config.cjs",
  "hardhat.config.js",
  "hardhat.config.mjs",
  "hardhat.config.ts",
  "package.json",
  "pom.xml",
  "pubspec.yaml",
  "pyproject.toml",
  "setup.py",
  "settings.gradle",
  "settings.gradle.kts"
]);

const MAX_UNIT_LINES = 1_500;

export function manifestDirectories(filePaths) {
  const directories = new Set();
  for (const filePath of filePaths) {
    if (MANIFEST_FILES.has(path.posix.basename(filePath))) {
      directories.add(path.posix.dirname(filePath));
    }
  }
  return directories;
}

export function groupForPath(filePath, manifestDirs, groupRoots = []) {
  const configuredRoot = groupRoots
    .filter((root) => filePath === root || filePath.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (configuredRoot) {
    return configuredRoot;
  }
  for (let directory = path.posix.dirname(filePath); directory !== "."; directory = path.posix.dirname(directory)) {
    if (manifestDirs.has(directory)) {
      return directory;
    }
  }
  return filePath.includes("/") ? filePath.split("/")[0] : ".";
}

export function parseChangedLines(patchText) {
  const changedLines = new Set();
  let currentLine = null;

  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentLine = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      currentLine = Number.parseInt(hunk[1], 10) + (hunk[2] === "0" ? 1 : 0);
      continue;
    }
    if (currentLine === null) {
      continue;
    }
    if (line.startsWith("+")) {
      changedLines.add(Math.max(1, currentLine));
      currentLine += 1;
    } else if (line.startsWith("-")) {
      changedLines.add(Math.max(1, currentLine));
    } else if (!line.startsWith("\\")) {
      currentLine += 1;
    }
  }

  return [...changedLines].sort((left, right) => left - right);
}

export function changedLineRanges(sortedLines) {
  const ranges = [];
  for (const line of sortedLines) {
    const previous = ranges.at(-1);
    if (previous && line === previous[1] + 1) previous[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

function hunkCoordinates(oldLine, oldCount, newLine, newCount) {
  return `@@ -${oldLine - (oldCount === 0 ? 1 : 0)},${oldCount} +${newLine - (newCount === 0 ? 1 : 0)},${newCount} @@`;
}

function splitHunk(body, layout, maximumBytes) {
  const { header, suffix } = layout;
  const overheadBytes = Buffer.byteLength(`${header}${suffix}\n`, "utf8");
  const overheadLines = header.split("\n").length;
  const chunks = [];
  let { oldLine, newLine } = layout;
  const empty = (start) => ({ start, oldLine, newLine, oldCount: 0, newCount: 0, bytes: 0, lines: 0, changes: 0 });
  let segment = empty(0);
  const coordinates = (oldCount, newCount) => hunkCoordinates(segment.oldLine, oldCount, segment.newLine, newCount);
  const fits = (record) =>
    overheadLines + segment.lines + record.lines <= MAX_UNIT_LINES &&
    overheadBytes +
      segment.bytes +
      record.bytes +
      coordinates(segment.oldCount + record.oldCount, segment.newCount + record.newCount).length <=
      maximumBytes;
  const account = (record, direction) => {
    for (const field of ["oldCount", "newCount", "bytes", "lines", "changes"])
      segment[field] += direction * record[field];
  };
  const emit = (end) => {
    if (!segment.changes) return;
    const text =
      header +
      coordinates(segment.oldCount, segment.newCount) +
      suffix +
      "\n" +
      body
        .slice(segment.start, end)
        .map((record) => record.text)
        .join("");
    assert(Buffer.byteLength(text, "utf8") <= maximumBytes, "patch split exceeded limit");
    chunks.push(text);
  };
  for (const [index, record] of body.entries()) {
    if (!fits(record) && segment.changes) {
      emit(index);
      segment = empty(index);
    }
    while (!fits(record) && segment.start < index) {
      const context = body[segment.start++];
      account(context, -1);
      segment.oldLine += context.oldCount;
      segment.newLine += context.newCount;
    }
    if (fits(record)) {
      account(record, 1);
    } else {
      assert(!record.changes, "a single diff line exceeds the maximum unit size");
    }
    oldLine += record.oldCount;
    newLine += record.newCount;
    if (!segment.lines) segment = empty(index + 1);
  }
  emit(body.length);
  return chunks;
}

export function splitPatch(patchText, maximumBytes) {
  assert(Number.isInteger(maximumBytes) && maximumBytes >= 10_000, "maximum unit size must be at least 10000 bytes");
  const lines = patchText.replace(/\n$/u, "").split("\n");
  const chunks = [];
  let sectionStart = 0;
  for (let index = 1; index <= lines.length; index += 1) {
    if (index === lines.length || lines[index].startsWith("diff --git ")) {
      chunks.push(...splitPatchSection(lines.slice(sectionStart, index), maximumBytes));
      sectionStart = index;
    }
  }
  return chunks;
}

function splitPatchSection(lines, maximumBytes) {
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) {
    const chunk = `${lines.join("\n")}\n`;
    assert(Buffer.byteLength(chunk, "utf8") <= maximumBytes, "metadata-only patch exceeds the maximum unit size");
    return [chunk];
  }

  const header = lines
    .slice(0, firstHunk)
    .map((line) => `${line}\n`)
    .join("");
  const chunks = [];
  const hunkLines = lines.slice(firstHunk);
  for (let index = 0; index < hunkLines.length; ) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(hunkLines[index]);
    assert(match, `invalid unified diff hunk header: ${hunkLines[index]}`);
    const oldLine = Number.parseInt(match[1], 10) + (match[2] === "0" ? 1 : 0);
    const newLine = Number.parseInt(match[3], 10) + (match[4] === "0" ? 1 : 0);
    const suffix = match[5];
    index += 1;
    const body = [];
    while (index < hunkLines.length && !hunkLines[index].startsWith("@@")) {
      const record = [hunkLines[index]];
      index += 1;
      assert([" ", "+", "-"].includes(record[0][0]), "invalid unified diff record");
      if (index < hunkLines.length && hunkLines[index] === "\\ No newline at end of file") {
        record.push(hunkLines[index]);
        index += 1;
      }
      const marker = record[0][0];
      const text = `${record.join("\n")}\n`;
      body.push({
        text,
        bytes: Buffer.byteLength(text, "utf8"),
        lines: record.length,
        oldCount: marker === "+" ? 0 : 1,
        newCount: marker === "-" ? 0 : 1,
        changes: marker === " " ? 0 : 1
      });
    }

    chunks.push(...splitHunk(body, { header, suffix, oldLine, newLine }, maximumBytes));
  }
  assert(chunks.length > 0, "patch has no changed records");
  return chunks;
}

export function packUnitsIntoBatches(units, maximumBatchBytes) {
  assert(Number.isInteger(maximumBatchBytes) && maximumBatchBytes > 0, "maximum batch size must be a positive integer");
  const groups = new Map();
  for (const unit of units) {
    assert(unit.bytes <= maximumBatchBytes, `review unit ${unit.id} exceeds the maximum batch size`);
    const group = groups.get(unit.group) ?? [];
    group.push(unit);
    groups.set(unit.group, group);
  }

  const chunks = [];
  for (const group of groups.values()) {
    let chunk = [];
    let chunkBytes = 0;
    for (const unit of group) {
      if (chunk.length > 0 && (chunkBytes + unit.bytes > maximumBatchBytes || chunk.length >= MAX_BATCH_UNITS)) {
        chunks.push({ units: chunk, bytes: chunkBytes });
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(unit);
      chunkBytes += unit.bytes;
    }
    if (chunk.length > 0) chunks.push({ units: chunk, bytes: chunkBytes });
  }

  const bins = [];
  for (const chunk of [...chunks].sort((left, right) => right.bytes - left.bytes)) {
    const bin = bins.find(
      (candidate) =>
        candidate.bytes + chunk.bytes <= maximumBatchBytes &&
        candidate.units.length + chunk.units.length <= MAX_BATCH_UNITS
    );
    if (bin) {
      bin.units.push(...chunk.units);
      bin.bytes += chunk.bytes;
    } else {
      bins.push({ units: [...chunk.units], bytes: chunk.bytes });
    }
  }
  return bins.sort((left, right) => compareStrings(left.units[0].id, right.units[0].id)).map((bin) => bin.units);
}

export function reviewerTurnBudget(unitCount, totalBytes = 0) {
  assert(Number.isInteger(unitCount) && unitCount >= 0, "unit count must be a non-negative integer");
  assert(Number.isInteger(totalBytes) && totalBytes >= 0, "review byte count must be a non-negative integer");
  const byteTurns = Math.ceil(totalBytes / 20_000);
  return Math.min(120, Math.max(40, 15 + 8 * unitCount + byteTurns));
}

export function verifierTurnBudget(candidateCount) {
  assert(Number.isInteger(candidateCount) && candidateCount >= 0, "candidate count must be a non-negative integer");
  return Math.min(120, Math.max(60, 12 + 6 * candidateCount));
}
