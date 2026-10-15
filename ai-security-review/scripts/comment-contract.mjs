import { assert } from "./assert.mjs";

export const COMMENT_MARKER = "<!-- matter-labs-ai-security-review -->";
export const MAX_COMMENT_BYTES = 60_000;

export function assertCommentBody(body) {
  assert(typeof body === "string" && body.startsWith(COMMENT_MARKER), "Comment artifact has an invalid marker.");
  assert(Buffer.byteLength(body, "utf8") <= MAX_COMMENT_BYTES, `Comment artifact exceeds ${MAX_COMMENT_BYTES} bytes.`);
}
