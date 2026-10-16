import { readFileSync } from "node:fs";

export function readTrace(filePath, { id = "read-1", offset = 1, limit = 2_000 } = {}) {
  const lines = readFileSync(filePath, "utf8").replaceAll("\r\n", "\n").split("\n");
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath, offset, limit } }]
      }
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: lines
              .slice(offset - 1, offset - 1 + Math.min(limit, 2_000))
              .map((line, index) => `${offset + index}\t${line}`)
              .join("\n")
          }
        ]
      }
    }
  ];
}
