---
name: router-stats
description: Show how the model router routed prompts and what subagents really cost, from local logs. Use when the user asks about router usage, model costs, or savings ("cuánto he gastado", "router stats").
argument-hint: "[days]"
---

Run, with the number of days from the arguments (default 7):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/stats.mjs" --days 7
```

If `${CLAUDE_PLUGIN_ROOT}` is not substituted, use the first `stats.mjs` that exists: `~/.claude/model-router/scripts/stats.mjs`, `.claude/model-router/scripts/stats.mjs` in the project, or the `model-tier-router` plugin's copy under `~/.claude/plugins` (find it with Glob).

Show the report as printed. Then add at most two lines: which tier costs the most and, if one stands out, a concrete way to cut it (for example, briefs that keep escalating). Costs are list-price estimates for subagents only; the main session is not included.

$ARGUMENTS
