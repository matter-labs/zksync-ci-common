import { readFileSync } from "node:fs";

export const CANDIDATE_SCHEMA = JSON.parse(
  readFileSync(new URL("../schemas/candidates.schema.json", import.meta.url), "utf8")
);
export const VERDICT_SCHEMA = JSON.parse(
  readFileSync(new URL("../schemas/verdicts.schema.json", import.meta.url), "utf8")
);

export const MAX_BATCH_UNITS = CANDIDATE_SCHEMA.properties.unit_reviews.maxItems;
export const MAX_VERIFIABLE_CANDIDATES = VERDICT_SCHEMA.properties.verdicts.maxItems;
