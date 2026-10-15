import { appendFileSync } from "node:fs";
import { createClaudeSession } from "./claude-session.mjs";
import { requiredEnvironment } from "./script-utils.mjs";

const session = createClaudeSession({
  sourceDirectory: requiredEnvironment("SOURCE_DIRECTORY"),
  engineRoot: requiredEnvironment("ENGINE_ROOT"),
  temporaryDirectory: requiredEnvironment("RUNNER_TEMP")
});
appendFileSync(
  requiredEnvironment("GITHUB_OUTPUT"),
  `working_directory=${session.workingDirectory}\nsettings_file=${session.settingsFile}\nsource_directory=${session.sourceDirectory}\n`
);
