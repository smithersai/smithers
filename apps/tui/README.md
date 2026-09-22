# smithers-tui

A minimal terminal coding agent over the Smithers cell harness.

The agent has no tools. Each model turn writes a JavaScript cell that calls
flows through `ctx.call`. The TUI streams each cell as it is written, then its
flow calls, printed output, and result.

```sh
pnpm install                     # from the repository root
pnpm --filter smithers-tui start -- [directory]
bun apps/tui/src/main.tsx --model openai:gpt-6-astra <directory>
```

The default seat is `openai:gpt-6-sol` on the ChatGPT subscription
(`codex login`). The picker lists only providers this machine can reach.

| Key | Action |
| --- | --- |
| Enter | Send |
| Shift+Enter, Ctrl+J | Newline |
| Esc | Stop the running turn |
| Ctrl+P, `/model` | Pick a model |
| `/model provider:id` | Use any seat |
| Ctrl+O | Expand folded code and output |
| PageUp, PageDown | Scroll |
| `/new` | Clear the conversation |
| Ctrl+C, `/exit` | Quit |

## Layout

| File | Role |
| --- | --- |
| `src/host.ts` | One in-process harness: memory engine, seat resolver, workspace observer, filesystem and shell flows. One turn is one `Agent.run`. |
| `src/transcript.ts` | Pure fold of `AgentEvent`s into user, cell, and answer items. |
| `src/app.tsx` | opentui React view. |
| `src/models.ts` | Picker entries from `@smthrs/cli/Providers` detection. |
| `src/ask.ts` | Headless probe; `SMITHERS_TUI_RECORD=file.jsonl` records a run for fixtures. |

Without `AI_GATEWAY_API_KEY` the completion brake that asks Jev is disarmed
(`claimCap: 0`); you read every answer. Edits are not rolled back by the
harness; your VCS is the undo.
