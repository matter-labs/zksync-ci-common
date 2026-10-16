import { assert } from "./assert.mjs";

export function gitlinks(tree) {
  const entries = new Map();
  for (const record of tree.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(record);
    assert(match, "invalid tree entry while checking submodule coverage");
    if (match[1] === "160000") entries.set(match[4], match[3]);
  }
  return entries;
}

export function changedGitlinks(baseTree, headTree) {
  const base = gitlinks(baseTree);
  const head = gitlinks(headTree);
  return [...new Set([...base.keys(), ...head.keys()])].sort().flatMap((file) => {
    const before = base.get(file) ?? null;
    const after = head.get(file) ?? null;
    return before === after ? [] : [{ path: file, before, after }];
  });
}

export function assertGitlinkCoverage(changes, units) {
  const coveredPaths = new Set(units.flatMap((unit) => [unit.path, unit.oldPath]));
  for (const change of changes) {
    assert(
      coveredPaths.has(change.path),
      `submodule change is missing from review units: ${JSON.stringify(change.path)}`
    );
  }
}
