---
title: Configuration and context
description: Configure providers, worker capacity, instructions, and local storage.
order: 23
section: Reference
---

The TUI reads provider credentials and its settings from the process environment. Browser provider settings belong to the browser playground and do not configure the terminal.

## Providers

| Variable/account                      | Purpose                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A signed-in Codex CLI account         | Detected ChatGPT subscription; OpenAI subscription seats take precedence in the picker.                                  |
| `SMITHERS_OPENAI_AUTH=chatgpt`        | Explicitly select the subscription route when its account is available.                                                  |
| `OPENAI_API_KEY`                      | OpenAI API access.                                                                                                       |
| `ANTHROPIC_API_KEY`                   | Anthropic access.                                                                                                        |
| `OPENROUTER_API_KEY`                  | OpenRouter access.                                                                                                       |
| `MOONSHOT_API_KEY`                    | Moonshot/Kimi access.                                                                                                    |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY`  | Gemini access.                                                                                                           |
| `CEREBRAS_API_KEY`                    | Cerebras access; preferred for interactive chat when configured.                                                         |
| `SMITHERS_OPENAI_COMPATIBLE_BASE_URL` | An OpenAI-compatible transport override.                                                                                 |
| `AI_GATEWAY_API_KEY`                  | Jev evaluation and monitor judging. Without it, the TUI disarms its completion-claim brake and refuses monitor creation. |

Provider availability and model support are checked by the runtime. Do not put secrets in Markdown prompts, example fixtures, or committed configuration.

## TUI settings

| Variable                              | Default or behavior                                                        |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `SMITHERS_TUI_SEAT`                   | Default chat model; overridden by `--model`.                               |
| `SMITHERS_TUI_WORKER_SEAT`            | Default worker model.                                                      |
| `SMITHERS_TUI_WORKER_SEATS`           | Comma-separated fallback order, excluding the requested seat and Cerebras. |
| `SMITHERS_TUI_WORKERS`                | Six concurrent worker slots; queued work is FIFO.                          |
| `SMITHERS_TUI_APPROVE`                | `all`; `ask` and `deny` are supported. CLI flag wins.                      |
| `SMITHERS_TUI_SESSION_DIR`            | Overrides the session storage root.                                        |
| `VISUAL`, then `EDITOR`               | Prompt editor for Ctrl+G; falls back to `nano`.                            |
| `SMITHERS_TUI_BIN`                    | Explicit compiled TUI for the CLI launcher.                                |
| `SMITHERS_BUN`                        | Bun executable for the CLI launcher.                                       |
| `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` | Native workspace helper override for flow/control operations.              |

The theme is stored at `~/.smithers/tui/theme`; `/theme` changes it. See [recording tools](./recordings.md) for replay-only variables.

## Instruction files

Each turn includes the working directory and applicable instructions. `~/.smithers/agent/AGENTS.md` comes first. From the repository root to the working directory, each directory contributes the first existing file among `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md`. Outside a repository, only the working directory is searched for local instructions.

```tui-script instruction-context
Use "basic"
Type "!cat AGENTS.md"
Press Enter
Wait for "Keep changes small."
Capture "Inspect the project instructions included with the task."
Type "/session"
Press Enter
Wait for "exchanges"
Capture "Find the session and log storing the conversation."
```

File references, prior conversation, included shell output, and relevant worker results form the rest of the context. `!!command` excludes its output; `/compact` drops eligible older conversation entries from later requests.
