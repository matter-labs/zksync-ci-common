import { assert } from "./assert.mjs";

const GLOB_TOKEN_CACHE = new Map();

const MAX_GLOB_LENGTH = 300;

function compileGlob(glob) {
  assert(typeof glob === "string" && glob.length > 0, "path profile glob must be a non-empty string");
  assert(glob.length <= MAX_GLOB_LENGTH, `path profile glob may contain at most ${MAX_GLOB_LENGTH} characters`);
  assert(!/[\u0000-\u001f\u007f]/u.test(glob), "path profile glob contains control characters");

  const cached = GLOB_TOKEN_CACHE.get(glob);
  if (cached) {
    return cached;
  }

  const characters = [...glob];
  const tokens = [];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "*") {
      if (characters[index + 1] === "*") {
        index += 1;
        if (characters[index + 1] === "/") {
          index += 1;
          tokens.push({ type: "globstar-slash" });
        } else {
          tokens.push({ type: "globstar" });
        }
      } else {
        tokens.push({ type: "star" });
      }
    } else if (character === "?") {
      tokens.push({ type: "single" });
    } else {
      tokens.push({ type: "literal", value: character });
    }
  }
  GLOB_TOKEN_CACHE.set(glob, tokens);
  return tokens;
}

export function matchesGlob(glob, value) {
  const tokens = compileGlob(glob);
  const characters = [...value];
  let following = new Uint8Array(characters.length + 1);
  following[characters.length] = 1;

  for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
    const token = tokens[tokenIndex];
    const current = new Uint8Array(characters.length + 1);
    if (token.type === "literal" || token.type === "single") {
      for (let index = characters.length - 1; index >= 0; index -= 1) {
        const matches = token.type === "literal" ? characters[index] === token.value : characters[index] !== "/";
        current[index] = matches && following[index + 1] ? 1 : 0;
      }
    } else if (token.type === "star") {
      current[characters.length] = following[characters.length];
      for (let index = characters.length - 1; index >= 0; index -= 1) {
        current[index] = following[index] || (characters[index] !== "/" && current[index + 1]) ? 1 : 0;
      }
    } else if (token.type === "globstar") {
      let suffixMatches = 0;
      for (let index = characters.length; index >= 0; index -= 1) {
        suffixMatches ||= following[index];
        current[index] = suffixMatches;
      }
    } else {
      let slashSuffixMatches = 0;
      for (let index = characters.length; index >= 0; index -= 1) {
        if (index < characters.length && characters[index] === "/" && following[index + 1]) {
          slashSuffixMatches = 1;
        }
        current[index] = following[index] || slashSuffixMatches ? 1 : 0;
      }
    }
    following = current;
  }

  return following[0] === 1;
}

export function validateGlob(glob) {
  compileGlob(glob);
}
