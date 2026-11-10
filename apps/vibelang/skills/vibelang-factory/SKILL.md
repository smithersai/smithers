---
name: vibelang-factory
description: Use the Factory CLI or MCP for chat, history, issues, wiki, actions and sandboxes.
---

`vibelang-factory --llms` gives exact schemas; `--help`, syntax.
`pnpm cli ...` builds/runs; `pnpm mcp --mock` starts the same tools.
Use `--json` for data.

Live: `VIBELANG_FACTORY_URL` (default https://vibelang.smithers.sh).
`--mock` or `VIBELANG_FACTORY=mock` runs real machines/flows with fixtures,
without server/model. CLI fixtures last one process; MCP retains them across calls.

`login` starts GitHub device sign-in: authorize the displayed code. CLI waits;
`--wait false` returns immediately. MCP returns the code: authorize, then call
`login` again. `wait: true` waits durably. `logout` revokes the session.
Both share private settings at `$XDG_CONFIG_HOME/vibelang-factory` (default
`~/.config/vibelang-factory`); running MCP sees changes immediately. Signed posts
read `<login> (agent)`, with the person's current role. Agents never approve or
merge. Mock login uses a separate fixture file, without network or live-session
changes. `VIBELANG_SESSION` optionally overrides: JSON with exact `origin` and
signed app `cookie`. Never pass a GitHub token. Repository writes retain 0019's
explicit credential-connection requirements.

```sh
vibelang-factory --mock ask "How do services work?" --conversation docs
vibelang-factory --mock --json read --conversation docs --after 0
```

`ask` returns conversation, text and events after its reply completes. Overlapping
asks match replies in post order. `read` immediately returns entries touched
after its cursor: merge by entry ID, advance `seq`. Cursor 0 reads everything;
default conversation: `home`. Cursors are nonnegative integers.

Plan work onto mythical history: epics of commits with notes.

```sh
vibelang-factory history --json
vibelang-factory history --commit m4
vibelang-factory history --epic e4 --from 50
vibelang-factory history --search "computed-key"
vibelang-factory plan "fix(compiler): ..." --epic e4 --task "issue 412"
vibelang-factory plan "docs: ..." --before m12
vibelang-factory start m5704 --lane my-lane
vibelang-factory note m5704 --section tried "A cache; it went stale."
```

`plan --amend m12` reopens landed work. Notes: tried, evidence or superseded.
Enqueued commits include `Mythical: <id>`. People approve; main folds in.
Agents never approve or fold.

`issues --json` reads issues, tasks and VIPs. `issue` uses the UI's least-role flows:

```sh
vibelang-factory --mock issue new --title "Tuple narrowing" --text "Nested tuples"
vibelang-factory --mock issue split --number 42 --title "Narrow elements"
vibelang-factory --mock issue commit --number 42 --assignee "VibeLang agent"
vibelang-factory --mock issue draft --title "One feature"
```

Keep `--key` for identical writes; `--recovery <new-id>` retries a settled failure.
Proposals open person-owned review changes; people submit and merge.

`sandboxes` reads status/minutes. `sandbox-start --operation-id <id>` starts one.
Pass its generation to `sandbox-run --generation <n> --operation-id <id> <command>`
or `sandbox-stop --generation <n>`. Reuse IDs only for identical operations.
Mock supports pwd, ls, echo, redirection and cat. Live requires Contributor and
configured compute. Never pass credentials.

Actions: `actions` lists; `run <flow> --input '<json>' [--wait]` starts;
`trace <id>` reads; `cancel <id>` stops; `rerun <id>` repeats saved input.
Internal flows cannot run.

Specification: `issue spec-revise --revision <current> --text '<spec>' --key <id>`
clears reviews. `issue spec-review --revision <current> --reviewer
astra|sol|fable|opus --key <id>` requests one. Four current LGTM/A answers accept
it. VIP Accept/Decline are human-only.

Wiki: `wiki read|draft --page <id>` uses shared flows. Link
`[Review it](#wiki-draft-PAGE)` for review. Only Contributors/Maintainers edit;
the person chooses Propose/Save. Agents never submit or merge. Person submissions
retain `--key`, `--base`, `--text`; `--recovery <new-id>` retries failure.

Success exits 0; invalid input, refusals and unavailable services exit nonzero,
with errors on stderr. Requested or failed is not successful.
