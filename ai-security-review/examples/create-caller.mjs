import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [sha, template = "pull-requests", ...extra] = process.argv.slice(2);
const templates = new Set(["pull-requests", "labelled-drafts", "merge-queue", "required-review"]);
if (extra.length || !/^[0-9a-f]{40}$/u.test(sha ?? "") || !templates.has(template)) {
  console.error(
    "Usage: node create-caller.mjs FULL_ENGINE_SHA [pull-requests|labelled-drafts|merge-queue|required-review]"
  );
  process.exit(1);
}

const caller = readFileSync(new URL(`callers/${template}.yaml`, import.meta.url), "utf8").replaceAll(
  "ENGINE_COMMIT_SHA",
  sha
);
mkdirSync(".github/workflows", { recursive: true });
const destination = ".github/workflows/ai-security-review-caller.yaml";
writeFileSync(destination, caller, { flag: "wx" });
console.log(`Created ${destination}; review its triggers, authentication and engine pin before committing.`);
