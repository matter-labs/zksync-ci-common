const DEPENDENCY_MAPS = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

function npmPackagePath(location) {
  if (location.length === 2 && location[0] === "packages") return true;
  return (
    location.length >= 2 &&
    location.length % 2 === 0 &&
    location.every((part, index) => index % 2 !== 0 || part === "dependencies")
  );
}

function npmSourceField(location) {
  const field = location.at(-1);
  if (npmPackagePath(location.slice(0, -1)) && ["resolved", "version", "from"].includes(field)) return "url";
  if (npmPackagePath(location.slice(0, -2)) && (DEPENDENCY_MAPS.has(location.at(-2)) || location.at(-2) === "requires"))
    return "url";
  return null;
}

function dependencySpecifier(location) {
  return (
    DEPENDENCY_MAPS.has(location[0]) &&
    (location.length === 2 || (location.length === 3 && ["specifier", "version"].includes(location[2])))
  );
}

function pnpmSourceField(location, parent) {
  if (location.length === 2 && ["overrides", "registries"].includes(location[0])) return "url";
  const packageEntry = ["packages", "snapshots"].includes(location[0]);
  if (packageEntry && location.length === 3 && location[2] === "<key>") return "url";
  if (packageEntry && location.length === 4 && location[2] === "resolution") {
    if (location[3] === "tarball") return "url";
    if (location[3] === "repo") return parent.type === "git" ? "git" : "url";
  }
  const relative = packageEntry || location[0] === "importers" ? location.slice(2) : location;
  return dependencySpecifier(relative) ? "url" : null;
}

function yarnSourceField(location) {
  if (location[0] === "__metadata") return null;
  if (location.length === 2 && ["<key>", "resolved", "resolution", "version"].includes(location[1])) return "url";
  return location.length === 3 && DEPENDENCY_MAPS.has(location[1]) ? "url" : null;
}

function bunSourceField(location) {
  if (location.length === 2 && ["overrides", "resolutions"].includes(location[0])) return "url";
  if (location[0] === "workspaces") return dependencySpecifier(location.slice(2)) ? "url" : null;
  if (location[0] !== "packages") return null;
  if (location.length === 3 && ["0", "1"].includes(location[2])) return "url";
  return location[2] === "2" && dependencySpecifier(location.slice(3)) ? "url" : null;
}

function pythonSourceField(filename, location, parent) {
  if (location[0] !== "package") return null;
  if (location.length === 4 && location[2] === "source") {
    if (location[3] === "url") return parent.type === "git" ? "git" : "url";
    if (filename === "uv.lock" && location[3] === "git") return "git";
    if (filename === "uv.lock" && location[3] === "registry") return "url";
  }
  if (filename === "uv.lock" && location.at(-1) === "url") {
    if (location.length === 4 && location[2] === "sdist") return "url";
    if (location.length === 5 && location[2] === "wheels") return "url";
  }
  return null;
}

export function lockfileSourceField(filename, location, parent, document) {
  switch (filename) {
    case "package-lock.json":
      return npmSourceField(location);
    case "pnpm-lock.yaml":
      return pnpmSourceField(location, parent);
    case "yarn.lock":
      return yarnSourceField(location);
    case "bun.lock":
      return bunSourceField(location);
    case "uv.lock":
    case "poetry.lock":
      return pythonSourceField(filename, location, parent);
    case "Cargo.lock":
      return location.length === 3 && location[0] === "package" && location[2] === "source" ? "url" : null;
    case "composer.lock":
      if (
        ["packages", "packages-dev"].includes(location[0]) &&
        ["source", "dist"].includes(location[2]) &&
        ((location.length === 4 && location[3] === "url") ||
          (location.length === 6 && location[3] === "mirrors" && location[5] === "url"))
      )
        return (document?.[location[0]]?.[location[1]]?.[location[2]] ?? parent).type === "git" ? "git" : "url";
      return null;
    case "flake.lock":
      if (
        location.length === 4 &&
        location[0] === "nodes" &&
        ["locked", "original"].includes(location[2]) &&
        location[3] === "url"
      )
        return parent.type === "git" ? "git" : "url";
      return null;
    case "Gemfile.lock":
      return location.length === 2 && location[0] === "remotes" ? "url" : null;
    default:
      return null;
  }
}
