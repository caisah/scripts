Add a `Co-authored-by` trailer for each distinct tool or model involved in authoring the commit; if the CLI host and the underlying model have separate trailers, include both.

Known co-author trailers:
- `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` - host tool; include when using copilot cli
- `Co-authored-by: claude-code[bot] <claude-code[bot]@users.noreply.github.com>` - model or integrated tool; include when using Claude model or Claude Code
- `Co-authored-by: Gemini CLI <gemini-cli@google.com>` - model or integrated tool; include when using Gemini model or gemini-cli
- `Co-authored-by: opencode <noreply@opencode.ai>` - host tool; include when using opencode
- `Co-authored-by: GPT <noreply@openai.com>` - model or integrated tool; include when using GPT model or Codex
