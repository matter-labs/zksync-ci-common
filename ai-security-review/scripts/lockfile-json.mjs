import assert from "node:assert/strict";
import { parse, visit } from "jsonc-parser";

export function parseLockfileJson(contents, jsonc = false) {
  const options = { allowTrailingComma: jsonc, disallowComments: !jsonc };
  const containers = [];
  let records = 0;
  const count = () => assert(++records <= 1_000_000, "JSON lockfile exceeds validation limits");
  const begin = (keys) => {
    count();
    assert(containers.length < 100, "JSON lockfile exceeds nesting limit");
    containers.push(keys);
  };
  visit(
    contents,
    {
      onObjectBegin: () => begin(new Set()),
      onArrayBegin: () => begin(null),
      onObjectEnd: () => containers.pop(),
      onArrayEnd: () => containers.pop(),
      onLiteralValue: count,
      onObjectProperty: (key) => {
        count();
        const keys = containers.at(-1);
        assert(keys instanceof Set && !keys.has(key), "duplicate JSON lockfile key");
        keys.add(key);
      },
      onError: () => assert.fail("invalid JSON lockfile")
    },
    options
  );
  return jsonc ? parse(contents, [], options) : JSON.parse(contents);
}
