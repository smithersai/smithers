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

It runs on Bun or on Node 26.4 or later. `smthrs tui` (and `npx smthrs tui`)
takes the same flags and picks the runtime: `SMITHERS_TUI_BIN`, then an
installed compiled binary, then Bun (`SMITHERS_BUN`, or a CLI already on Bun),
then this Node with `--experimental-ffi`. To run it on Node from the
repository:

```sh
node packages/smithers/scripts/build-tui.mjs
node --experimental-ffi --disable-warning=ExperimentalWarning packages/smithers/dist/tui/main.js [directory]
bun packages/smithers/scripts/build-tui-binaries.mjs --single   # compile this platform's binary
```

Interactive chat prefers `cerebras:qwen-3.8-27b` with low reasoning effort
when `CEREBRAS_API_KEY` is configured, falling back to an available provider.
`--model` or `SMITHERS_TUI_SEAT` overrides chat. Background workers use the
first available non-Cerebras seat (usually the ChatGPT subscription from
`codex login`); `SMITHERS_TUI_WORKER_SEAT` overrides it. Workers try the other
detected non-Cerebras seats after a provider limit; `SMITHERS_TUI_WORKER_SEATS=a,b`
sets that fallback order. The picker lists only
providers this machine can reach. Print mode runs a task directly.

Edits, shell commands, and network calls run without asking. `--approve ask`
(or `SMITHERS_TUI_APPROVE=ask`) makes each wait for **y**/**n**; `deny` refuses
them. The flag wins over the variable, and `-p` cannot `ask`.

## Keys

`src/keys.ts` lists every key; the footer, the `?` panel, `/hotkeys`, and
Ctrl+O read it.

| Key | Action |
| --- | --- |
| Enter | Send. While a turn runs: steer, delivered before the next cell |
| Alt+Enter | Queue a follow-up for after the turn |
| Alt+Up | Move queued follow-ups back to the editor |
| Shift+Enter, Ctrl+J | Newline |
| Esc | Stop the turn (queued messages return to the editor) or the shell command |
| ? | With the editor empty: show the keys for the current context. Esc or ? closes it; other typing keeps the `?` |
| y, n, a | Approval row showing its keys (editor empty, 400 ms after the row appears and after the editor last changed): allow once, deny, and where the row offers `a all bash` or `a all edits`, allow for the session. Otherwise the key is text |
| Ctrl+C | Clear the editor; twice within 500 ms to exit |
| Ctrl+D | Exit when the editor is empty |
| Up, Down | Prompt history |
| `/` | Commands: Up/Down choose, Tab inserts, Enter runs, Esc closes the menu |
| `@` | Mention a file (`git ls-files`, else `rg --files`), fuzzy-matched |
| Ctrl+K | Search: commands and files; `/` commands, `text:` file text (rg, `text:/re/` for a regex), `session:` resumes, `tab:` opens a worker, `?` lists prefixes. Enter inserts `@path` or `@path:line`, runs the command, or opens the item. Replaces the editor's Ctrl+K (delete to line end); Ctrl+U and Ctrl+W remain |
| Ctrl+L | Model dialog; type to filter |
| Ctrl+P, Shift+Ctrl+P | Next, previous model |
| Shift+Tab | Cycle reasoning effort |
| Ctrl+O | Expand cell code, output, diffs, and the key list |
| Ctrl+T | Inspect the run timeline; arrows scrub, [ ] or Shift+Left/Right step milestones, Home/End jump, Esc returns to live |
| Ctrl+S | Open summary / switch focus between the view and chat |
| Ctrl+], Ctrl+\\, Ctrl+Right, Ctrl+Left | Next, previous tab: Chat, Summary, worker tabs, trees, and custom views. Click a tab to open it |
| Ctrl+\\ or `/chat` | Return to full chat from a main view |
| hjkl or arrows | In a view: move between rows, collapse/expand details |
| Enter | In a view: toggle the selected row's details |
| d, v | In a view: toggle the selected turn's diff; toggle split/unified |
| u | In the Summary view or a worker tab: undo the selected row's captured file changes (confirm first) |
| Tab | In a view: next tab |
| Esc, i | In a view: focus the composer without stopping background work |
| a | Activate the selected row's action, if present |
| r, x | In a worker or flow tab: resume / stop. A worker resumes with its prior steps on its original model |
| m, w | In a failed worker tab: choose a model for resume / wait for reset |
| a | In a flow tab: approve or fill in |
| Tab/Down, Shift+Tab/Up, Space, Left/Right, Enter, Esc | In a flow form: next, previous field, toggle, choose, run, close (the run stays parked) |
| Ctrl+G | Edit the prompt in `$VISUAL` / `$EDITOR` |
| PageUp, PageDown | Scroll |
| Shift+Up, Shift+Down | Scroll a line |
| `!cmd` | Run a shell command; its output joins the next turn's context |
| `!!cmd` | Run a shell command and keep it out of context |

## Commands

`/model [query]`, `/thinking [level]`, `/new`, `/resume`, `/fork`, `/session`, `/compact`,
`/name <name>`, `/copy`, `/summary`, `/tabs`, `/chat`, `/filter`,
`/grep [text]`, `/ui [id]`, `/smithers`, `/flows`, `/flow <name> [json|key=value]`, `/agent [name] [prompt]`,
`/retry <id>`, `/stop <id>`, `/hotkeys`, `/quit`. After `/model `, `/thinking `, `/flow ` and `/agent `
the menu completes the argument, and the `/` menu lists the directory's flows.

## Look

Night Owl dark surfaces from the Smithers app (`apps/app/.../tokens.css`),
layered page, panel, element. Your messages keep the composer's shape, a
brand bar on a filled panel. Each cell is a left bar colored by status with
one row per flow call (`→ read`, `$ ran`, `← edited`); an edit draws its diff.
The Summary view keeps cell code behind expandable rows. Panels, dialogs, and the
completion menu follow opencode's shapes; fuzzy matching is pi's.

The bottom timeline shows recorded phases, edits, stalls, and verification
receipts. It follows running workers while chat stays usable. Inspection reads
the journal up to the selected event, so later results do not appear early.
Restoring a session reconstructs the same timeline from its saved events.
Worker tabs show `queued` (waiting for a pool seat), `requested`, `running`,
`waiting` for children, `parked` (⏸ with a reset time), `done`, `failed`, or
`cancelled`. Running, waiting, and parked workers auto-relaunch from their
recorded steps when the TUI restarts. Queued workers keep the chat context
captured with their request. A failed worker shows a short failure card; Ctrl+O
reveals the raw error and stack.

## Context and sessions

Each turn is told the working directory, instruction files (the first of
`AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` in every directory from the
repository root down, or the working directory alone outside a repository,
after `~/.smithers/agent/AGENTS.md`), and the conversation so far.
Sessions are owner-only JSONL under `~/.smithers/tui/sessions/<cwd>--<hash>/`
(`SMITHERS_TUI_SESSION_DIR` overrides). A torn last line is dropped; a file
damaged earlier is renamed `.damaged` and left out of the list. `/fork` starts a new session from the
messages before a chosen one and puts that message back in the editor; the
original stays resumable.

Without `AI_GATEWAY_API_KEY` the completion brake that asks Jev is disarmed
(`claimCap: 0`); you read every answer. **u** on a Summary or worker tab row
reverses its captured changes after a confirm, all or nothing; a deleted
file comes back with its mode. It refuses when a file
changed since, a change is binary or large, or the turn ran a shell command
that changed files: a shell diff can hold other workers' edits. The session
records the undo and the next turn is told. `/new`, `/resume` and `/fork` wait
for it.

## Runtime UI and delegation

The summary is a projection onto the same panel format agents can publish.
It starts with one sentence, followed by chronological rows. Each row retains
its cell source, flow calls, output, errors, and observed file changes.
Diffs have syntax highlighting, line numbers, contextual hunks, and a split
view on wide terminals. Filesystem flows capture edits, whole-file overwrites,
patches, deletions, and moves; creation and deletion are marked with
`/dev/null`, so they undo. Shell changes observed during a call are captured in Git and jj repositories;
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
never takes keyboard focus. `placement:"main"` shows a view beside chat at
120 columns or wider, or above chat on smaller terminals. `bind:{tree:rootId}`
adds live worker rows to that view. Documents are schema-validated, capped at 1 MB,
and persisted in the session. The host renders them; generated code is never
loaded into the UI process.

The chat coordinator has `ui.publish`, `agent.delegate`, `tab.read`,
`tab.list`, and `tab.retry`. Workers also have `agent.delegate`, `agent.wait({ids})`,
`tab.read`, and `tab.list`. A worker can delegate children through depth 3;
depth 4 returns `AgentDepthExceeded`. Waiting releases the worker's pool slot.
Delegation takes `{id, title, prompt}`, persists before launch, and returns a
`requested` receipt immediately. Reusing the id deduplicates the request.
A tab's one-line description comes from the worker's own seat. `r` or `/retry`
resumes a failed, stopped, or parked tab on its requested model.
Up to six workers can run at once (`SMITHERS_TUI_WORKERS` overrides the pool);
later requests queue FIFO. They share the working directory, so
independent tasks should name disjoint files. Worker transcripts persist in
separate session files, and the chat interleaves their rows by time inside a
colored rail titled `↳ <worker>`. `/filter` shows or hides the chat, each
worker, and each kind of row; `/grep <text>` keeps rows containing the text and
`/grep` alone clears it. Chat receives every unsettled worker and the newest
five settled answers (1,500 characters each) as context, and remains usable
while workers run. Progress uses the shared toast stack,
with a 300 ms delay and real completion/failure as its end. A `tree:<rootId>`
tab appears when a worker gains children; its rows update from tab state.

Workers run locally. Restarting the TUI restores their transcripts and
auto-relaunches running and waiting workers; parked workers relaunch at reset.
`/new`, `/resume`, and `/fork`
require running work to finish or be stopped first.

## Flows

`/flows` lists the file flows in `<cwd>/flows/<name>/flow.ts` (a `Flow.make`
default export) with their descriptions; Enter runs one. `/flow <name>` takes a
JSON object or `key=value` arguments. A run starts in its
own tab and runs through the same native control host as `smthrs flow start`: plan,
approve for this run, run, watch. Missing required input opens a form built
from the payload schema once the composer is empty and no approval is pending;
Esc, Ctrl+K, Ctrl+S and the tab keys close it and leave the run parked. A flow whose envelope grants every capability (`*`)
waits for **a** (or Enter in its form) instead of starting. Its status settles
only from the control plane's watch; **x** asks the control plane to cancel.

Listing reads `flows/` without importing anything; the first run imports the
flow modules and opens `<cwd>/.flows` (the store `smthrs runs` reads), so an
edited `flow.ts` needs a restart. A markdown flow is a custom agent (below);
choosing one in `/flows` starts `/agent <name> `. Do not run `smthrs` executors
in the same directory at the same time. Restarting marks unfinished runs
interrupted; retry resumes the durable run.
`/smithers` opens one tab with every run, newest first, and the discovered flows.

Every turn runs with `SmithersPlugin` from `@smthrs/agent`: the system prompt
names the key packages and `smthrs` verbs, and `smithers.guide` returns the
details. The coordinator also gets `smithers.flows`, `smithers.run` and
`smithers.inspect` over the same runs (model-invocable flows only);
`smithers.run` returns a `requested` receipt at once. `smithers.flows` returns
`{name, description, agent, input}`: `input` lists up to 12
`{name, type, required}` fields once a run has imported the module (listing
never imports it), and `[{name: "args"}]` for an agent. The coordinator's
`Flow runs:` context also lists the store's 20 newest runs this session did not
start, such as `smthrs flow start` runs, marked `by: "cli"`. Reading them opens
no flow module and creates no store.

## Monitors

The coordinator has `monitor.create`, `monitor.list` and `monitor.stop`. A
monitor watches a worker tab, a `smithers.run` run, or a shell command's output,
on source events or an interval (10 s to 24 h; shell needs one). Each change
goes to Jev (`AI_GATEWAY_API_KEY`), which answers whether it is notable for the
monitor's `watch`; only a yes asks `openai:gpt-6-luna` for a one-line update,
shown as a toast and a chat row. An unchanged source asks nothing. There is no
fallback: without the key `monitor.create` is refused, and a Jev, Luna or
source failure fails the monitor with a typed error row. Creating the same id
restarts it. A shell monitor runs its command every tick, so creating one is
asked like `bash` under `--approve ask` and refused under `deny`; on `/resume`
and `-c` it asks again before its command runs. Monitors persist in the
session and resume on `/resume` and `-c`.

## Estimates

Every chat turn, worker tab and flow run gets a time and token estimate when it
is requested, and is scored when it settles. A flow or a turn is estimated from
its own past runs; a delegated task asks GPT-6 Luna with the most similar past
tasks and the model's own past errors in the prompt, or takes the median task
without a model. A model failure is logged with its reason and toasts once.
Scores calibrate the next estimate. A running tab and a working turn show
`~7m·250k` (time left, tokens) or `late`; the coordinator's `tab.eta` flow
answers ETA questions, queued tabs included. The eval log is
`<session dir>/<cwd slug>/evals/estimates.jsonl`. See
`.plans/estimation-system.md`.

## Custom agents

A custom agent is a markdown flow, `flows/<name>/flow.mdx` (or `SKILL.md`).
There is no other agent format: `smthrs flow start`, approvals and the app read
the same file. The body is the agent's system prompt; the frontmatter sets the
rest.

```yaml
---
description: Reviews the uncommitted change and returns a verdict.  # picker row
model: sol          # sol, astra, luna, opus, fable, qwen, or provider:modelId
effort: high        # none, minimal, low, medium, high, xhigh, max
capabilities: ["fs:read:**", "proc:spawn:*"]  # envelope; absent = every capability
flows: [read, grep, bash]  # standard flows it may call; absent = all of them
disable-model-invocation: false  # true = only a person may start it
---
```

`/agent` opens the Agents picker (name, model, description); choosing a row
puts `/agent <name> ` in the composer, because the prompt is the agent's one
field. `/agent <name> <prompt>` opens a worker tab titled `<name>: <prompt>`.
The coordinator sees `Agents: [{name, description}]` (model-invocable agents,
at most 20) and starts one with `agent.delegate {id, title, prompt, agent}`.

Both doors persist the tab and return `requested` before the file is read; the
body is read when the tab launches, so chat stays usable while it loads. The
seat is the request's `model`, then the file's `model:`, then the worker seat.
The tab runs as a worker with the body appended to the worker instructions,
`effort` as its reasoning effort, `capabilities` as its envelope and `flows`
narrowing the filesystem and shell flows. The registry lists a body that
declares `flows:` with capabilities `*`; the tab still runs under the file's
own `capabilities:`. Retry reads the file again, so edits apply,
and keeps the agent and the model. The tab records `agent: {name, digest}`.

Every refusal is a code and one line:

| Code | When | Where |
| --- | --- | --- |
| `unknown_agent` | No flow has that name | Refused at once (tab `failed` if the first listing had not arrived) |
| `not_an_agent` | The name is a `flow.ts` module | Refused at once; use `/flow` or `smithers.run` |
| `not_invocable` | `disable-model-invocation: true` and the coordinator asked | Refused at once |
| `unreadable` | The body could not be read | Tab `failed`, retryable |
| `unknown_seat` | `model:` names no alias or known provider | Tab `failed` |
| `unknown_effort` | `effort:` is not a reasoning effort | Tab `failed` |

`examples/custom-agent` is a directory with one agent; run
`bun run tui apps/tui/examples/custom-agent` and type `/agent review`.


## Tests

| Command | What |
| --- | --- |
| `bun test ./test` | Transcript fold over a recorded run, and the pure modules |
| `bun test ./e2e` | The TUI in a real PTY through [zmux](https://github.com/smithersai/zmux): keys in, screen out |

The end-to-end suite needs `zmuxd` (`$ZMUXD`, `PATH`, or `~/zmux/zig-out/bin`).
Its model turns replay `test/fixtures/fix-add.jsonl` through the replay seat:
`SMITHERS_TUI_REPLAY=<file>` streams a run recorded with
`SMITHERS_TUI_APPROVE=all SMITHERS_TUI_RECORD=<file> bun src/ask.ts "<prompt>"`, and its cells run for
real. `SMITHERS_TUI_REPLAY_SPEED` and `SMITHERS_TUI_REPLAY_HOLD_MS` pace it.
