import { assert } from "./assert.mjs";
import { CANDIDATE_SCHEMA, MAX_BATCH_UNITS } from "./review-contract.mjs";

// Leave room below the launcher's per-argument limit for quoting and other Claude flags.
export const MAX_REVIEWER_SCHEMA_BYTES = 96 * 1024;

function schemaArgumentBytes(schema) {
  return Buffer.byteLength(JSON.stringify(schema).replaceAll("'", `'"'"'`));
}

function buildReviewerSchema(batch) {
  const ids = batch.units.map((unit) => unit.id);
  assert(ids.length > 0 && ids.length <= MAX_BATCH_UNITS, "invalid reviewer batch size");
  assert(new Set(ids).size === ids.length, "duplicate reviewer unit ID");
  const schema = structuredClone(CANDIDATE_SCHEMA);
  const review = schema.properties.unit_reviews.items;
  delete review.properties.unit_id;
  review.required = review.required.filter((field) => field !== "unit_id");
  schema.definitions = review.properties;
  schema.properties.unit_reviews = {
    type: "object",
    additionalProperties: false,
    required: ids,
    properties: Object.fromEntries(
      batch.units.map((unit) => {
        assert(
          Array.isArray(unit.changedLines) &&
            unit.changedLines.length > 0 &&
            unit.changedLines.every(
              (line, index, lines) => Number.isSafeInteger(line) && line > 0 && (index === 0 || line > lines[index - 1])
            ),
          `review unit ${unit.id} requires sorted, unique, positive changed lines`
        );
        return [
          unit.id,
          {
            ...review,
            properties: Object.fromEntries(
              Object.keys(review.properties).map((field) => [
                field,
                field === "evidence_line"
                  ? { type: "integer", enum: [...unit.changedLines] }
                  : { $ref: `#/definitions/${field}` }
              ])
            )
          }
        ];
      })
    )
  };
  schema.properties.findings.items.properties.unit_id.enum = ids;
  schema.properties.findings.items.anyOf = batch.units.map((unit) => {
    assert(typeof unit.path === "string" && unit.path.length > 0, `review unit ${unit.id} requires a path`);
    const key = unit.id.replaceAll("~", "~0").replaceAll("/", "~1");
    return {
      properties: {
        unit_id: { const: unit.id },
        file: { const: unit.path },
        line: { $ref: `#/properties/unit_reviews/properties/${key}/properties/evidence_line` }
      }
    };
  });
  return schema;
}

export function reviewerOutputSchema(batch) {
  const schema = buildReviewerSchema(batch);
  assert(
    schemaArgumentBytes(schema) <= MAX_REVIEWER_SCHEMA_BYTES,
    "reviewer schema exceeds the byte limit; split the review batch"
  );
  return schema;
}

export function splitReviewerBatch(units) {
  const schema = buildReviewerSchema({ units });
  if (schemaArgumentBytes(schema) <= MAX_REVIEWER_SCHEMA_BYTES) return [units];
  assert(
    units.length > 1,
    `review unit ${units[0].id} exceeds the reviewer schema byte limit; split the pull request into smaller changes`
  );
  const middle = Math.ceil(units.length / 2);
  return [...splitReviewerBatch(units.slice(0, middle)), ...splitReviewerBatch(units.slice(middle))];
}

export function normalizeReviewerOutput(value) {
  const reviews = value?.unit_reviews;
  assert(
    reviews && typeof reviews === "object" && !Array.isArray(reviews),
    "unit_reviews must be an object keyed by unit ID"
  );
  const entries = Object.entries(reviews);
  assert(entries.length <= MAX_BATCH_UNITS, `unit_reviews must contain at most ${MAX_BATCH_UNITS} entries`);
  return {
    ...value,
    unit_reviews: entries.map(([unit_id, review]) => {
      assert(review && typeof review === "object" && !Array.isArray(review), "unit review must be an object");
      assert(!Object.hasOwn(review, "unit_id"), "unit review must use its object key as the unit ID");
      return { unit_id, ...review };
    })
  };
}
