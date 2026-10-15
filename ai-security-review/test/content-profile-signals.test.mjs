import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  combinedContentSignals,
  contentProfileSignals,
  patchProfileSignals
} from "../scripts/content-profile-signals.mjs";
import { orderedProfiles, profilesForPath, validateProfileId } from "../scripts/profiles.mjs";

const config = { profiles: [], pathProfiles: [] };
const cases = [
  ["crypto-library", 'import { createHmac as hmac } from "node:crypto";', ["domains/cryptography"]],
  ["jwt-library", 'const jwt = require("jsonwebtoken");', ["domains/authorization", "domains/cryptography"]],
  ["policy-library", 'import { newEnforcer } from "casbin";', ["domains/authorization", "domains/policy-engine"]],
  ["http-library", 'const network = await import("undici");', ["domains/http-service"]],
  [
    "webcrypto-api",
    "await globalThis.crypto.subtle.verify(algorithm, key, signature, data);",
    ["domains/cryptography"]
  ],
  ["global-fetch-api", "await globalThis.fetch(destination);", ["domains/http-service"]],
  [
    "iam-policy-structure",
    '{"Statement":[{"Effect":"Allow","Action":"example:Read","Resource":"*"}]}',
    ["domains/authorization", "domains/policy-engine"]
  ]
];

test("fixed content signals select existing specialist profiles for ordinary paths", () => {
  for (const [id, text, profiles] of cases) {
    const signals = contentProfileSignals(`// unchanged header\n${text}\n`);
    assert.deepEqual(signals, [{ id, profiles, line: 2 }]);
    for (const profile of profiles) validateProfileId(profile, fileURLToPath(new URL("../profiles", import.meta.url)));
  }
  for (const module of [
    "crypto",
    "node:crypto",
    "jose",
    "jsonwebtoken",
    "casbin",
    "@casl/ability",
    "@open-policy-agent/opa-wasm",
    "http",
    "node:http",
    "https",
    "node:https",
    "undici",
    "axios"
  ]) {
    for (const statement of [
      `import '${module}';`,
      `export { value } from '${module}';`,
      `require(\n '${module}'\n)`
    ]) {
      assert.equal(contentProfileSignals(statement).length, 1, statement);
    }
  }
});

test("generic APIs, keywords and lookalike packages do not add specialist profiles", () => {
  for (const text of [
    "verify(token); execute(command); JSON.parse(input); db.query(sql); fetch(url);",
    'const domain = "domains/authorization"; // skip universal',
    'import x from "jose-helper"; require("./crypto"); import "axios-extra";',
    'const text = "crypto jwt authorization SQL permissions";',
    '{"Effect":"Allow","Action":"read","Resource":"*"}',
    '{"Statement": [], "Action":"read", "Resource":"*", "Effect":"Maybe"}',
    'transform "jose"; myrequire("crypto");'
  ])
    assert.deepEqual(contentProfileSignals(text), []);
});

test("comments and strings may add hints but cannot select arbitrary profiles or quote their content", () => {
  const secret = "synthetic-routing-secret";
  const signals = contentProfileSignals(
    `// from "jose" ${secret}\nconst example = 'globalThis.fetch(url)';\n// load ../../evil or domains/wallet-signing instead`
  );
  assert.deepEqual(
    signals.map((signal) => signal.id),
    ["global-fetch-api", "jwt-library"]
  );
  assert.ok(!JSON.stringify(signals).includes(secret));
  assert.ok(signals.every((signal) => !signal.profiles.includes("domains/wallet-signing")));
  signals[0].profiles.push("domains/wallet-signing");
  assert.deepEqual(contentProfileSignals("globalThis.fetch(url)")[0].profiles, ["domains/http-service"]);
});

test("content escalation preserves every existing path and configured profile", () => {
  const configuration = {
    profiles: ["domains/privacy-data-exposure"],
    pathProfiles: [{ paths: ["**/*.ts"], profiles: ["domains/distributed-system"] }]
  };
  for (const file of [
    "src/ordinary.ts",
    "data/settings.json",
    ".github/workflows/build.yaml",
    ".npmrc",
    "go.mod",
    "package.json",
    "modules/main.tf"
  ]) {
    const floor = profilesForPath(file, configuration);
    for (const [, text] of cases) {
      const profiles = orderedProfiles([...floor, ...contentProfileSignals(text).flatMap((signal) => signal.profiles)]);
      assert.ok(floor.every((profile) => profiles.includes(profile)));
      assert.equal(profiles[0], "universal");
      assert.equal(profiles.length, new Set(profiles).size);
    }
    assert.deepEqual(orderedProfiles([...floor, ...contentProfileSignals("export const count = 1;")]), floor);
  }
  assert.deepEqual(profilesForPath("data/settings.json", config), ["universal"]);
});

test("overlapping windows preserve split matches, line numbers and multi-key policy signals", () => {
  const prefix = "// padding\n".repeat(2_978);
  assert.equal(prefix.length, 32_758);
  const [signal] = contentProfileSignals(`${prefix}import { jwtVerify } from "jose";\n`);
  assert.deepEqual(signal, {
    id: "jwt-library",
    profiles: ["domains/authorization", "domains/cryptography"],
    line: 2_979
  });
  const body = `${prefix}globalThis.fetch(url);\n${prefix}import "node:crypto";\n`;
  assert.equal(contentProfileSignals(body).find((entry) => entry.id === "crypto-library").line, 5_958);
  const policy = `{"Statement":[{\n${" ".repeat(40_000)}"Effect":"Deny",\n${" ".repeat(40_000)}"NotAction":"x", "NotResource":"y"}]}`;
  assert.equal(contentProfileSignals(policy)[0].id, "iam-policy-structure");
});

test("patch fallback scans both revisions and all chunks without joining unrelated hunks", () => {
  const chunks = [
    'diff --git a/from "jose" b/from "jose"\n@@ -5,2 +5,2 @@\n-import "crypto";\n+import "axios";\n unchanged();\n',
    '@@ -100,1 +100,1 @@\n-require("casbin");\n+require("jose");\n'
  ];
  const base = patchProfileSignals(chunks, "base");
  const head = patchProfileSignals(chunks, "head");
  assert.deepEqual(
    base.map(({ id, line }) => ({ id, line })),
    [
      { id: "crypto-library", line: 5 },
      { id: "policy-library", line: 100 }
    ]
  );
  assert.deepEqual(
    head.map(({ id, line }) => ({ id, line })),
    [
      { id: "http-library", line: 5 },
      { id: "jwt-library", line: 100 }
    ]
  );
  assert.deepEqual(combinedContentSignals(base, head), [
    { id: "crypto-library", base_line: 5 },
    { id: "http-library", head_line: 5 },
    { id: "jwt-library", head_line: 100 },
    { id: "policy-library", base_line: 100 }
  ]);
  const both = contentProfileSignals('import "jose";');
  assert.deepEqual(combinedContentSignals(both, both), [{ id: "jwt-library", base_line: 1, head_line: 1 }]);
  assert.deepEqual(patchProfileSignals(["@@ -1,1 +1,1 @@\n-const a = 1;\n+const b = 1;"], "head"), []);
});

test("window boundaries neither lose known signals nor create keyword boundaries", () => {
  for (const [, text] of cases) {
    const expected = contentProfileSignals(text);
    for (const offset of [31_743, 31_744, 32_760, 32_767, 32_768, 65_535]) {
      assert.deepEqual(contentProfileSignals(`${" ".repeat(offset)}${text}`), expected);
    }
  }
  for (const offset of [31_743, 31_744, 32_760, 32_767, 32_768]) {
    assert.deepEqual(contentProfileSignals(`${"a".repeat(offset)}crypto.subtle.verify(x)`), []);
    assert.deepEqual(contentProfileSignals(`${"a".repeat(offset)}from "jose"`), []);
  }
});

test("hostile routing inputs remain bounded and signals cannot multiply prompt metadata", () => {
  assert.equal(
    contentProfileSignals(
      cases
        .map(([, text]) => text)
        .join("\n")
        .repeat(1_000)
    ).length,
    cases.length
  );
  const module = new URL("../scripts/content-profile-signals.mjs", import.meta.url);
  assert.doesNotMatch(readFileSync(module, "utf8"), /new RegExp/u);
  const source = `
    import { contentProfileSignals } from ${JSON.stringify(module.href)};
    const inputs = [
      " ".repeat(524288), "import" + " ".repeat(524280),
      'from "' + "x".repeat(524280), "globalThis" + " ".repeat(524270),
      '"Statement"' + " ".repeat(524270), "crypto.".repeat(70000),
      "require ( ".repeat(50000), 'from "jose'.repeat(40000)
    ];
    for (let index = 0; index < 20; index++) for (const input of inputs) contentProfileSignals(input);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
