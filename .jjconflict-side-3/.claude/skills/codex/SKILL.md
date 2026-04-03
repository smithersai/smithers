---
name: codex
description: Deploy OpenAI Codex CLI agents to implement tasks autonomously. Use when the user asks to run codex, deploy an agent, or delegate implementation work.
user-invocable: true
argument-hint: <prompt or issue description>
---

# Codex CLI Agent Deployment

Use the OpenAI Codex CLI to deploy autonomous coding agents. Codex agents read files, explore the codebase, and write code independently.

## Quick Reference

### Non-interactive mode (for background/parallel tasks):

```bash
codex exec -c model_reasoning_effort="xhigh" --dangerously-bypass-approvals-and-sandbox "<prompt>"
```

### Interactive mode (requires a TTY — cannot run from background tasks):

```bash
codex -c model_reasoning_effort="xhigh" --yolo "<prompt>"
```

**IMPORTANT**: Interactive mode (`codex` without `exec`) requires a TTY. When running from Claude Code's Bash tool with `run_in_background: true`, you MUST use `codex exec` instead. The interactive TUI will fail with "stdin is not a terminal" in background mode.

## Key Flags

| Flag | Purpose |
|------|---------|
| `exec` | Non-interactive subcommand (required for background execution) |
| `-c model_reasoning_effort="xhigh"` | Maximum reasoning effort |
| `-c model="<model>"` | Override model (default: gpt-5.2-codex) |
| `--dangerously-bypass-approvals-and-sandbox` | Skip all prompts, no sandbox (use for trusted repos) |
| `--full-auto` | Sandboxed auto-execution (safer alternative to bypass) |
| `--yolo` | Interactive mode equivalent of bypass (TTY only) |
| `-C <dir>` | Set working directory |
| `-i <file>` | Attach image(s) to the prompt |
| `--search` | Enable web search tool |
| `-s <mode>` | Sandbox: `read-only`, `workspace-write`, `danger-full-access` |
| `-o <file>` | Write last agent message to file |
| `--json` | Output JSONL events to stdout |

## Deployment Patterns

### Single background agent
```bash
codex exec -c model_reasoning_effort="xhigh" --dangerously-bypass-approvals-and-sandbox "Read issues/008-image-paste-in-chat.md and implement it. Read all relevant files before making changes."
```
Run with `run_in_background: true` in the Bash tool, then check output with `TaskOutput`.

### Multiple parallel agents
Launch several `codex exec` commands simultaneously using parallel Bash tool calls, each with `run_in_background: true`. Each gets its own task ID for monitoring.

### Resume a session
```bash
codex exec resume --last   # Resume most recent
codex resume               # Interactive picker (TTY only)
```

### Code review
```bash
codex exec review          # Review current changes
codex review               # Interactive review (TTY only)
```

## Prompt Best Practices

1. **Always tell codex to read the relevant files first**: "Read X.swift and Y.swift, then implement..."
2. **Reference issue files by path**: "Read issues/008-image-paste-in-chat.md carefully, then..."
3. **Be specific about scope**: List exact requirements rather than vague instructions
4. **Mention the architecture**: "This is a SwiftUI app using STTextView for editing..."

## Monitoring Background Agents

After launching with `run_in_background: true`:
- Use `TaskOutput` with `block: false` to check status without waiting
- Use `TaskOutput` with `block: true` to wait for completion
- Read the output file path directly with the `Read` tool for full logs

## Other Subcommands

| Command | Purpose |
|---------|---------|
| `codex apply` / `codex a` | Apply the latest diff from a codex session as `git apply` |
| `codex cloud` | Browse Codex Cloud tasks |
| `codex fork` | Fork a previous session |
| `codex debug` | Debugging tools |
| `codex mcp` | Run as MCP server |
