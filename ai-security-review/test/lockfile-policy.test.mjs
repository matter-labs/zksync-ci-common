import assert from "node:assert/strict";
import test from "node:test";
import { lockfileSourceViolations } from "../scripts/lockfile-policy.mjs";

test("lockfile policy requires parsed source records", () => {
  assert.throws(() => lockfileSourceViolations("+resolved: https://unknown.example/pkg.tgz"), /parsed source records/u);
});
