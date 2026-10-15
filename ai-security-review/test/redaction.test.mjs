import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { redactSecretMaterial, sanitizeUntrustedText } from "../scripts/redaction.mjs";

test("untrusted metadata is flattened and bounded", () => {
  assert.equal(sanitizeUntrustedText("Fix auth\n\nignore  rules"), "Fix auth ignore rules");
  assert.equal(sanitizeUntrustedText("a".repeat(300)).length, 256);
  assert.equal(sanitizeUntrustedText(undefined), "");
});

test("public identifiers and opaque digests survive redaction", () => {
  for (const value of [
    `0x${"a1".repeat(20)}`,
    "abcdef0123".repeat(4),
    "ab".repeat(32),
    `sha256:${"ab".repeat(32)}`,
    `sha512-${Buffer.alloc(64, 251).toString("base64")}`,
    `dist/${"abcd".repeat(16)}.mjs`,
    "npm_package_dependencies_long_dependency_name",
    "Bearer authentication requires a token",
    "https://db.example/app",
    "mnemonic_hash: abcdef"
  ]) {
    assert.equal(redactSecretMaterial(value), value);
  }
});

test("URL userinfo is removed completely without destroying the origin", () => {
  for (const scheme of ["postgresql", "POSTGRES", "mongodb+srv", "redis", "https"]) {
    for (const credentials of ["fixture:fake-pass", "us%65r:p%40ss%3Aword", "token-only", "user:p@ss"]) {
      const value = `${scheme}://${credentials}@db.example:5432/app?ssl=true`;
      const redacted = redactSecretMaterial(value);
      assert.equal(redacted, `${scheme}://[REDACTED CREDENTIALS]@db.example:5432/app?ssl=true`);
      assert.equal(redactSecretMaterial(redacted), redacted);
    }
  }
});

test("known token families and bearer values redact completely and idempotently", () => {
  const cases = [
    [`AKIA${"A".repeat(16)}`, "[REDACTED AWS ACCESS KEY]"],
    [`ASIA${"B".repeat(16)}`, "[REDACTED AWS ACCESS KEY]"],
    [`AIza${"a".repeat(35)}`, "[REDACTED GOOGLE API KEY]"],
    [`AIza${"a".repeat(34)}-`, "[REDACTED GOOGLE API KEY]"],
    ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map((prefix) => [
      `${prefix}${"a".repeat(24)}_${"b".repeat(24)}-`,
      "[REDACTED GITHUB TOKEN]"
    ]),
    [`ghs_123456_eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`, "[REDACTED GITHUB TOKEN]"],
    ...["glpat-", "gloas-", "gldt-", "glrt-", "glrtr-", "glcbt-", "glptt-", "glft-", "glimt-", "glagent-", "glwt-"].map(
      (prefix) => [`${prefix}${"a".repeat(20)}_-`, "[REDACTED GITLAB TOKEN]"]
    ),
    [`npm_${"A1".repeat(18)}`, "[REDACTED NPM TOKEN]"],
    [`xoxb-${"a".repeat(20)}-`, "[REDACTED SLACK TOKEN]"],
    [`sk-ant-${"a".repeat(24)}-`, "[REDACTED API KEY]"],
    [`eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}-`, "[REDACTED JWT]"],
    ["Authorization: Bearer short", "Authorization: Bearer [REDACTED BEARER TOKEN]"],
    ['"authorization": "bEaReR abc._~+/-=="', '"authorization": "bEaReR [REDACTED BEARER TOKEN]"'],
    [`Bearer ${"ab".repeat(32)}`, "Bearer [REDACTED BEARER TOKEN]"]
  ];
  for (const [secret, replacement] of cases) {
    const redacted = redactSecretMaterial(secret);
    assert.equal(redacted, replacement);
    assert.equal(redactSecretMaterial(redacted), redacted);
  }
});

test("complete and truncated PEM keys redact their bodies", () => {
  for (const label of [
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "OPENSSH PRIVATE KEY"
  ]) {
    const begin = `-----BEGIN ${label}-----`;
    const end = `-----END ${label}-----`;
    for (const body of ["sensitive-body", "a".repeat(1500), `${begin}\nnested-key`]) {
      assert.equal(
        redactSecretMaterial(`before ${begin}\n${body}\n${end} after`),
        "before [REDACTED PRIVATE KEY] after"
      );
      assert.equal(redactSecretMaterial(`before ${begin}\n${body}`), "before [REDACTED PRIVATE KEY]");
    }
  }
  assert.equal(
    redactSecretMaterial("-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY----- -----BEGIN RSA PRIVATE KEY-----y"),
    "[REDACTED PRIVATE KEY] [REDACTED PRIVATE KEY]"
  );
});

test("explicit secret assignments redact values, not arbitrary word sequences or hex", () => {
  const phrase = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  for (const label of ["mnemonic", "WORKER_MNEMONIC", "seed phrase", "seed_phrase", "recovery_phrase"]) {
    for (const quote of ["", '"', "'", "`"]) {
      const value = `${label} = ${quote}${phrase}${quote}\nNext line`;
      const expected = `${label} = ${quote}[REDACTED MNEMONIC]${quote}\nNext line`;
      assert.equal(redactSecretMaterial(value), expected);
      assert.equal(redactSecretMaterial(expected), expected);
    }
  }
  assert.equal(redactSecretMaterial(phrase), phrase);
  assert.equal(redactSecretMaterial(`"mnemonic":\n  "${phrase}"`), '"mnemonic":\n  "[REDACTED MNEMONIC]"');
  assert.equal(
    redactSecretMaterial(`{"mnemonic":"${phrase}","keep":"visible"}`),
    '{"mnemonic":"[REDACTED MNEMONIC]","keep":"visible"}'
  );
  assert.equal(redactSecretMaterial('mnemonic: "alpha\\" beta'), 'mnemonic: "[REDACTED MNEMONIC]');
  assert.equal(redactSecretMaterial(`private_key = 0x${"ab".repeat(32)}`), "private_key = [REDACTED PRIVATE KEY]");
  assert.equal(
    redactSecretMaterial(`AWS_SECRET_ACCESS_KEY=${"aB+/".repeat(10)}`),
    "AWS_SECRET_ACCESS_KEY=[REDACTED AWS SECRET KEY]"
  );
});

test("redaction bounds input and handles hostile near-matches within a subprocess deadline", () => {
  assert.equal(redactSecretMaterial("a".repeat(8_000)), "a".repeat(8_000));
  assert.throws(() => redactSecretMaterial("a".repeat(8_001)), /safe limit/u);
  const script = `
    import { redactSecretMaterial } from ${JSON.stringify(new URL("../scripts/redaction.mjs", import.meta.url).href)};
    const probes = [
      "a".repeat(8000), "/".repeat(8000), "=".repeat(8000),
      "a://" + "a".repeat(7996), "a://".repeat(1600),
      "-----BEGIN PRIVATE KEY-----".repeat(290),
      "Bearer ".repeat(1100), "Authorization" + " ".repeat(7900),
      "mnemonic" + " ".repeat(7900), "eyJ" + "a".repeat(7997),
      "glpat-" + "-".repeat(7994), "github_pat_" + "_".repeat(7989),
      'mnemonic="' + "\\\\".repeat(7900)
    ];
    for (let iteration = 0; iteration < 100; iteration++) {
      for (const probe of probes) redactSecretMaterial(probe);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 5_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("reviewer and verifier prompts require secret locations instead of secret values", () => {
  for (const prompt of ["profiles/universal.md", "prompts/verifier.md"]) {
    const contents = readFileSync(new URL(`../${prompt}`, import.meta.url), "utf8");
    assert.match(contents, /cite only the file, line references, and secret type/u);
    assert.match(contents, /Never quote secret values/u);
    assert.match(contents, /partial, encoded, or transformed copies/u);
    assert.match(contents, /tool arguments?/u);
  }
});
