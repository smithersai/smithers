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

Interactive chat prefers `cerebras:qwen-3.8-27b` with low reasoning effort
when `CEREBRAS_API_KEY` is configured, falling back to an available provider.
`--model` or `SMITHERS_TUI_SEAT` overrides chat. Background workers use the
first available non-Cerebras seat (usually the ChatGPT subscription from
`codex login`); `SMITHERS_TUI_WORKER_SEAT` overrides it. The picker lists only
providers this machine can reach. Print mode runs a task directly.

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
| Ctrl+S | Open summary / switch focus between the view and chat |
| Ctrl+Left, Ctrl+Right | Switch Chat, Summary, worker tabs, and custom views |
| hjkl or arrows | In a view: move between rows, collapse/expand details |
| Enter | In a view: toggle the selected row's details |
| d, v | In a view: toggle the selected turn's diff; toggle split/unified |
| Tab | In a view: next tab |
| Esc, i | In a view: focus the composer without stopping background work |
| a | Activate the selected row's action, if present |
| r, x | In a worker tab: retry / stop |
| Ctrl+G | Edit the prompt in `$VISUAL` / `$EDITOR` |
| PageUp, PageDown | Scroll |
| `!cmd` | Run a shell command; its output joins the next turn's context |
| `!!cmd` | Run a shell command and keep it out of context |

## Commands

`/model [query]`, `/thinking [level]`, `/new`, `/resume`, `/session`,
`/name <name>`, `/copy`, `/summary`, `/tabs`, `/chat`, `/ui [id]`,
`/retry <id>`, `/stop <id>`, `/hotkeys`, `/quit`. After `/model ` and
`/thinking ` the menu completes the argument.

## Look

Night Owl dark surfaces from the Smithers app (`apps/app/.../tokens.css`),
layered page, panel, element. Your messages are right-aligned brand-tinted
bubbles, as in the app's chat. Each cell is a left bar colored by status with
one row per flow call (`→ read`, `$ ran`, `← edited`); an edit draws its diff.
The Summary view keeps cell code behind expandable rows. Panels, dialogs, and the
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

## Runtime UI and delegation

The summary is a projection onto the same panel format agents can publish.
It starts with one sentence, followed by chronological rows. Each row retains
its cell source, flow calls, output, errors, and observed file changes.
Diffs have syntax highlighting, line numbers, contextual hunks, and a split
view on wide terminals. Filesystem flows capture edits, whole-file overwrites,
patches, deletions, and moves. Shell changes observed during a call are captured in Git and jj repositories;
shell edits outside a repository have no automatic diff. Binary, large, or excessively
expensive diffs are labeled instead of rendered as incomplete hunks.

Agents construct UI in sandboxed JavaScript cells through ordinary flows:

```js
await ctx.call("ui.publish", {
  id: "checks",
  title: "Checks",
  summary: "The addition check passed.",
  rows: [{
    id: "addition",
    label: "Checked addition",
    status: "done",
    details: [{ kind: "code", language: "javascript", code: "assert(add(2, 3) === 5)" }]
  }]
})
ctx.done("The check passed.")
```

Blocks support text, code, tables (`columns`, `rows`), and unified diffs
(`path`, `patch`). Rows optionally carry `action: {label, prompt}`; only the
user pressing **a** sends that prompt. Reusing a panel id updates it. Publishing
never takes keyboard focus. Documents are schema-validated, capped at 1 MB,
and persisted in the session. The host renders them; generated code is never
loaded into the UI process.

The chat coordinator has `ui.publish`, `agent.delegate`, `tab.read`, and
`tab.list`. Workers have the filesystem/shell flows and `ui.publish`.
Delegation takes `{id, title, prompt}`, persists before launch, and returns a
`requested` receipt immediately. Reusing the id deduplicates the request.
Up to three workers can run at once; they share the working directory, so
independent tasks should name disjoint files. Worker transcripts persist in
separate session files. Chat receives current worker status/results as context
and remains usable while workers run. Progress uses the shared toast stack,
with a 300 ms delay and real completion/failure as its end.

Workers run locally. Restarting the TUI restores their transcripts and marks
unfinished workers interrupted, with an explicit retry; it does not claim to
reconnect to a process that no longer exists. `/new` and `/resume` require
running work to finish or be stopped first.

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
