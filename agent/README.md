# Provider-neutral agent assets

This directory is the provider-neutral home for Panchito agent prompts and skills.

Current migration state:
- `agent/AGENTS.md`, `agent/roles/`, and `agent/skills/` mirror the current OpenCode assets.
- `opencode/` remains mounted for compatibility with the existing `opencode.json`.
- New Codex/app-server wiring should read from this neutral directory instead of hard-coding `opencode/`.

Keep verdict contracts provider-neutral: the blocking final response is authoritative;
live events are observability only.
