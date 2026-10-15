# AI agents and model-driven automation

Treat prompts, retrieved documents, repository content, issue text, tool output, and model output as untrusted data.
Check prompt-injection paths, tool and secret boundaries, excessive agent authority, untrusted code execution, data
exfiltration, cross-run context poisoning, identity and approval checks, output-to-command transitions, and unsafe
fallbacks when parsing or policy enforcement fails.

A finding must trace attacker-controlled model context to a concrete protected read or side effect. Do not report prompt
injection when the affected agent has no relevant tool, credential, data, or action capability.
