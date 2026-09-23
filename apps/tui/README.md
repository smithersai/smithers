# smithers-tui

A minimal terminal coding agent over the Smithers cell harness.

The agent has no tools. Each model turn writes a JavaScript cell that calls
flows through `ctx.call`. The TUI streams each cell as it is written, then its
flow calls, printed output, and result. Keys and commands follow
[pi](https://github.com/badlogic/pi-mono) where the cell harness has the same
idea.

```sh
bun run tui [directory]          # from the repository root
bun run tui -c                   # continue the latest session here
bun run tui -r                   # pick a session
bun run tui -p "prompt"          # print one answer and exit
bun run tui --model openai:gpt-6-astra
```

The default seat is `openai:gpt-6-sol` on the ChatGPT subscription
(`codex login`). The picker lists only providers this machine can reach.

## Keys

| Key | Action |
| --- | --- |
| Enter | Send. While a turn runs: steer, delivered before the next cell |
| Alt+Enter | Queue a follow-up for after the turn |
| Alt+Up | Move queued follow-ups back to the editor |
| Shift+Enter, Ctrl+J | Newline |
| Esc | Stop the turn (queued messages return to the editor) or the shell command |
| Ctrl+C | Clear the editor; twice within 500 ms to exit |
| Ctrl+D | Exit when the editor is empty |
| Up, Down | Prompt history |
| `/` | Commands: Up/Down choose, Tab inserts, Enter runs, Esc closes the menu |
| `@` | Mention a file (`git ls-files`, else `rg --files`), fuzzy-matched |
| Ctrl+L | Model dialog; type to filter |
| Ctrl+P, Shift+Ctrl+P | Next, previous model |
| Shift+Tab | Cycle reasoning effort |
| Ctrl+O | Expand cell code, output, diffs, and the key list |
| Ctrl+G | Edit the prompt in `$VISUAL` / `$EDITOR` |
| PageUp, PageDown | Scroll |
| `!cmd` | Run a shell command; its output joins the next turn's context |
| `!!cmd` | Run a shell command and keep it out of context |

## Commands

`/model [query]`, `/thinking [level]`, `/new`, `/resume`, `/session`,
`/name <name>`, `/copy`, `/hotkeys`, `/quit`. After `/model ` and
`/thinking ` the menu completes the argument.

## Look

Night Owl dark surfaces from the Smithers app (`apps/app/.../tokens.css`),
layered page, panel, element. Your messages are right-aligned brand-tinted
bubbles, as in the app's chat. Each cell is a left bar colored by status with
one row per flow call (`→ read`, `$ ran`, `← edited`); an edit draws its diff.
Cell code folds to a line count once settled. Panels, dialogs, and the
completion menu follow opencode's shapes; fuzzy matching is pi's.

## Context and sessions

Each turn is told the working directory, instruction files (the first of
`AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` in every directory from the
root down, after `~/.smithers/agent/AGENTS.md`), and the conversation so far.
Sessions are JSONL under `~/.smithers/tui/sessions/<cwd>/`
(`SMITHERS_TUI_SESSION_DIR` overrides).

Without `AI_GATEWAY_API_KEY` the completion brake that asks Jev is disarmed
(`claimCap: 0`); you read every answer. Edits are not rolled back by the
harness; your VCS is the undo.

## Tests

| Command | What |
| --- | --- |
| `bun test ./test` | Transcript fold over a recorded run, and the pure modules |
| `bun test ./e2e` | The TUI in a real PTY through [zmux](https://github.com/smithersai/zmux): keys in, screen out |

The end-to-end suite needs `zmuxd` (`$ZMUXD`, `PATH`, or `~/zmux/zig-out/bin`).
Its model turns replay `test/fixtures/fix-add.jsonl` through the replay seat:
`SMITHERS_TUI_REPLAY=<file>` streams a run recorded with
`SMITHERS_TUI_RECORD=<file> bun src/ask.ts "<prompt>"`, and its cells run for
real. `SMITHERS_TUI_REPLAY_SPEED` and `SMITHERS_TUI_REPLAY_HOLD_MS` pace it.
