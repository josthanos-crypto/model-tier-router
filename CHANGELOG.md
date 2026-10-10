# Changelog

## 1.0.0 - 2026-10-10

First release.

- Local, zero-token prompt classifier for English and Spanish, with `!` prefixes to force a tier.
- Five tiers (fast, standard, deep, max, frontier) as subagents pinned to full model IDs and clamped effort levels.
- Brief, verify and escalate procedure in the `router` skill; `router-stats` cost report.
- Subagent telemetry with list-price cost, including 1-hour cache writes and Haiku 5.5 long-context pricing.
- Model catalog built from Anthropic's docs or Models API, with sanity checks; weekly workflow opens a PR when models, prices or effort levels change.
- Generated agents, `docs/MODELOS.md`, the README tier table and a claude.ai preferences block.
- Project and user installer for setups without the plugin system, including Claude Code cloud sessions.
