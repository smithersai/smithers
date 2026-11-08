---
name: vibelang-factory
description: Use the VibeLang Factory CLI or MCP for chat, mythical history, wiki drafts, issues, VIPs and sandboxes.
---

`vibelang-factory --llms` gives exact schemas; `--help`, syntax.
`pnpm cli ...` builds/runs; `pnpm mcp --mock` starts the same tools.
Use `--json` for data.

Live: `VIBELANG_FACTORY_URL` (default https://vibelang.smithers.sh); unavailable/mock-only
origins fail with `LiveBackendNotDeployed`. `--mock` or `VIBELANG_FACTORY=mock` runs
real machines/flows with fixtures and scripted replies, without server/model.
CLI fixtures last one process; MCP retains them across calls.

Live writes require `VIBELANG_SESSION`: redacted JSON with `origin` and the
signed app session `cookie`, bound to `VIBELANG_FACTORY_URL`. Connect GitHub as
that person before issue or wiki writes. Never put a GitHub token in arguments.

```sh
vibelang-factory --mock ask "How do services work?" --conversation docs
vibelang-factory --mock --json read --conversation docs --after 0
```

`ask` returns conversation, text and events after its reply completes; overlapping
asks match replies in post order. Live posts reach everyone. `read` immediately
returns entries touched after its cursor: merge by entry ID, advance `seq`.
Cursor 0 reads everything; default conversation: `home`. Cursors are nonnegative integers.

Work is planned onto mythical history: epics of small commits with notes.

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

`plan --amend m12` reopens a landed commit. Notes accept tried, evidence or
superseded. Include `Mythical: <id>` in the enqueued commit message. People
approve; main folds in. Agents never approve or fold.

`issues --json` reads GitHub's issues, committed tasks and VIPs. `issue` runs
the same least-role flows as the UI:

```sh
vibelang-factory --mock issue new --title "Tuple narrowing" --text "Nested tuples"
vibelang-factory --mock issue split --number 42 --title "Narrow elements"
vibelang-factory --mock issue commit --number 42 --assignee "VibeLang agent"
vibelang-factory --mock issue draft --title "One feature"
vibelang-factory --mock issue propose --title "One feature" --text "Summary" --example "const pair = [1, 2]" --prior "Rust"
```

Keep `--key` for an identical write; `--recovery <new-id>` explicitly retries a
settled failure. Proposals create a person-owned review change under
`docs/design/vips/` and a tracking issue. People review, submit and merge.

`sandboxes` reads status, remaining minutes and generation. `sandbox-start
--operation-id <stable-id>` starts one. Pass the observed generation to
`sandbox-run --generation <n> --operation-id <stable-id> <command>` or
`sandbox-stop --generation <n>`. Reuse an operation ID only for its identical
operation; stale generations are refused. Mock commands support pwd, ls, echo,
redirection and cat; unsupported commands fail honestly. Live compute requires
Contributor, authenticated 0019 policy and the deployment's Container binding.
Never put credentials in commands or environment.

Registered actions: `actions` lists; `run <flow> --input '<json>' [--wait]` starts;
`trace <id>` reads; `cancel <id>` stops; `rerun <id>` retains input with a new id.
Roles come from the host. Internal flows cannot run.

Success exits 0; invalid input, refusals and unavailable backends exit nonzero
with an error on stderr. A requested or failed operation is not successful.

Specification state is in `issue read --json`'s `detail`. Maintainers write
`issue spec-revise --revision <current> --text '<spec>' --key <stable>`;
a revision clears all answers. Request
`issue spec-review --revision <current> --reviewer astra|sol|fable|opus --key <stable>`.
The reviewer supplies its verdict; callers cannot. Acceptance requires four
current LGTM/A answers. VIP Accept/Decline are human-only.

Wiki: `wiki read|draft --page <id>` uses the shared flow.
Link `[Review it](#wiki-draft-PAGE)` for the person to review the retained draft.
Only Contributors/Maintainers edit; the person chooses Propose/Save. Agents never
submit or merge. Person submissions retain `--key`, `--base` and `--text`;
`--recovery <new-id>` retries a settled failure.
