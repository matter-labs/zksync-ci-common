import { assert } from "./assert.mjs";

const SECRET_REDACTIONS = [
  [
    /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?bearer[ \t]+)[A-Za-z0-9._~+/-]+=*/giu,
    "$1[REDACTED BEARER TOKEN]"
  ],
  [/\b(bearer[ \t]+)[A-Za-z0-9._~+/-]{16,}=*/giu, "$1[REDACTED BEARER TOKEN]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED AWS ACCESS KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}/gu, "[REDACTED GOOGLE API KEY]"],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_.-]{20,}/gu, "[REDACTED GITHUB TOKEN]"],
  [
    /\b(?:glpat|gloas|gldt|glrt|glrtr|glcbt|glptt|glft|glimt|glagent|glwt)-[A-Za-z0-9_.-]{16,}/gu,
    "[REDACTED GITLAB TOKEN]"
  ],
  [/\bnpm_[A-Za-z0-9]{20,}/gu, "[REDACTED NPM TOKEN]"],
  [/\bxox[a-z]-[A-Za-z0-9-]{10,}/gu, "[REDACTED SLACK TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/gu, "[REDACTED API KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, "[REDACTED JWT]"]
];

const MAX_REDACTION_INPUT_CHARS = 8_000;

const MAX_UNTRUSTED_METADATA_CHARS = 256;

function redactPrivateKeys(value) {
  const beginPattern = /-----BEGIN ([A-Z ]{0,64}PRIVATE KEY)-----/gu;
  const parts = [];
  let cursor = 0;
  for (let match = beginPattern.exec(value); match; match = beginPattern.exec(value)) {
    const endMarker = `-----END ${match[1]}-----`;
    const end = value.indexOf(endMarker, beginPattern.lastIndex);
    parts.push(value.slice(cursor, match.index), "[REDACTED PRIVATE KEY]");
    cursor = end === -1 ? value.length : end + endMarker.length;
    beginPattern.lastIndex = cursor;
  }
  return parts.join("") + value.slice(cursor);
}

function redactUrlCredentials(value) {
  return value.replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#"'<>`]+/giu, (authority) => {
    const userinfoEnd = authority.lastIndexOf("@");
    if (userinfoEnd === -1) return authority;
    const schemeEnd = authority.indexOf("://") + 3;
    return `${authority.slice(0, schemeEnd)}[REDACTED CREDENTIALS]${authority.slice(userinfoEnd)}`;
  });
}

function assignmentValueEnd(value, start, quote) {
  for (let index = start; index < value.length; index += 1) {
    if (quote && value[index] === "\\") index += 1;
    else if (quote ? value[index] === quote : value[index] === "\n" || value[index] === "\r") return index;
  }
  return value.length;
}

function redactSecretAssignments(value) {
  const labelPattern =
    /(?<![A-Za-z0-9])(?<label>mnemonic|seed[ _-]phrase|recovery[ _-]phrase|private[ _-]key|(?:aws_)?secret_access_key)["']?\s*[:=]\s*/giu;
  const parts = [];
  let cursor = 0;
  for (let match = labelPattern.exec(value); match; match = labelPattern.exec(value)) {
    const valueStart = labelPattern.lastIndex;
    const quote = ["'", '"', "`"].includes(value[valueStart]) ? value[valueStart] : "";
    const start = valueStart + quote.length;
    const end = assignmentValueEnd(value, start, quote);
    const label = match.groups.label.toLowerCase();
    const replacement = label.startsWith("private")
      ? "[REDACTED PRIVATE KEY]"
      : label.endsWith("access_key")
        ? "[REDACTED AWS SECRET KEY]"
        : "[REDACTED MNEMONIC]";
    parts.push(value.slice(cursor, start), replacement);
    cursor = end;
    labelPattern.lastIndex = end;
  }
  return parts.join("") + value.slice(cursor);
}

export function sanitizeUntrustedText(value, maximum = MAX_UNTRUSTED_METADATA_CHARS) {
  return (
    String(value ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control characters from untrusted metadata.
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, maximum)
  );
}

export function redactSecretMaterial(value) {
  assert(typeof value === "string", "secret redaction input must be a string");
  assert(value.length <= MAX_REDACTION_INPUT_CHARS, "secret redaction input exceeds the safe limit");
  const redacted = redactSecretAssignments(redactUrlCredentials(redactPrivateKeys(value)));
  return SECRET_REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), redacted);
}
