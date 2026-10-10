---
name: router
description: Pick the right Claude model and effort for a task, or orchestrate multi-step work across model tiers (Haiku, Sonnet, Opus, Fable) with verification and escalation. Use when the user asks which model to use ("qué modelo uso", "which model"), wants cost and quality balanced, splits work across subagents, or wants to configure the router (main model, on/off).
argument-hint: "[task] | config | update"
---

# Model router

The router has five tiers. Each one is a subagent that pins a real model ID and effort, generated from `models/catalog.json`, so the names below stay current:

| Tier | subagent_type | Use for |
|---|---|---|
| fast | `model-tier-router:router-fast` | Lookups, searches, renames, formatting, conversions, summaries, extracting data from text. |
| standard | `model-tier-router:router-standard` | Clear, well-specified work with a checkable result: a defined change in 1 to 3 files, tests, emails, documents, tables. |
| deep | `model-tier-router:router-deep` | Complex work still taking shape: unknown cause, design decision, multi-file change. Returns a plan unless the brief says IMPLEMENT. |
| max | `model-tier-router:router-max` | The hardest problems, or work that failed at deep. |
| frontier | `model-tier-router:router-frontier` | Only on request (`!fable`) or after two failures at max: long multistep research, a finished report, sheet or deck. |

The SessionStart note in your context names the exact model and effort behind each tier. If a `model-tier-router:*` agent is not available, use the bare name (`router-fast`, ...) or fall back to `general-purpose` with the tier's model alias.

## "Which model should I use for X?"

Answer in one or two lines, in the user's language: the tier, the model, the effort, and the reason. Judge by what the work needs, not by the size of the material. When it is close, prefer the cheaper tier and say what would justify going up. In claude.ai the user switches by hand; in Claude Code the prefixes `!fast`, `!std`, `!deep`, `!max`, `!fable` force a tier and `!off` skips routing for one message.

## Orchestrating multi-step work

You plan, split, delegate and verify; subagents execute. Keep the intelligence in planning and verification.

1. Split the work into tasks. Each has one outcome, the files or material it may touch, and an acceptance check (a test, a command, or an observable result). A task with no cheap check goes to deep at minimum.
2. Pick the tier per task with the table above. Do not delegate work that is quicker to do than to brief, and do not spawn a subagent for one trivial edit.
3. Write a brief that needs no other context: goal, paths or material, constraints, acceptance check, and the short report you expect. Spawn with `subagent_type` only; do not also pass `model`, which would override the pinned one.
4. Run independent tasks in parallel in one message; dependent ones in sequence.
5. Verify every result yourself: read the diff or output and run the check. Never report success you did not verify.
6. Escalate: on `ESCALATE` or a failed check, retry once at the same tier with a sharper brief that adds what was missing. If it fails again, go one tier up, with a summary of what was tried. Frontier only after two failures at max.

## `config`

Settings live in `~/.claude/model-router/config.json` (create it if missing; keep unknown keys):

- `"main_model": "opus"` (default, Anthropic's recommended lead) or `"sonnet"` (budget: Sonnet leads, Opus plans through subagents). Ask which model the main session runs if unclear.
- `"enabled": false` turns routing off; `"log": false` stops writing `routing.jsonl`.
- `"thresholds": { "fast_max_chars": 160, "deep_score": 3, "max_score": 6 }` tunes the classifier.

Show the change before writing it. For a one-off, the environment variable `MODEL_ROUTER=off` disables the hooks.

## `update`

The catalog updates itself in the repository every week. To pull it: `/plugin marketplace update model-tier-router`, then `/reload-plugins`. If the user names a model the SessionStart note does not list, say the catalog may be behind and suggest that command; check Anthropic's models overview page with WebFetch only if they ask.

$ARGUMENTS
