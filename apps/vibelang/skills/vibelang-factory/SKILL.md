---
name: vibelang-factory
description: Talk to the VibeLang factory agent and read conversations through its Factory CLI.
---

Use `vibelang-factory` to work with vibelang.smithers.sh's Factory service. Run
`vibelang-factory --llms` first for the current command names and exact input/output schemas.
Use `--help` or `ask --help` for CLI syntax. From this app checkout, `pnpm cli ...`
builds and runs the CLI; the package bin points to its emitted executable.

Commands use the live Factory at `VIBELANG_FACTORY_URL` (default
https://vibelang.smithers.sh): a real agent answers, and everyone in a conversation
sees its posts. If that deployment runs only the mock agent or can't be reached,
commands fail with `LiveBackendNotDeployed`. Pass `--mock` or set
`VIBELANG_FACTORY=mock` for the mock: the real conversation state machine and
scripted replies, with no server or model. Mock data lasts for one process:
separate CLI calls start empty. To share a mock conversation
across calls, use the MCP server (`pnpm mcp --mock`); its tools have the same schemas.

Post a message and wait for its entire reply:

```sh
vibelang-factory --mock ask "How do I install it?"
vibelang-factory --mock --json ask "How do services work?" --conversation docs
```

`ask` returns `conversation`, completed reply `text`, and the numbered `events` for
that post and reply. Overlapping asks are matched to their replies in post order.

Read a finite snapshot:

```sh
vibelang-factory --mock --json read --after 0
vibelang-factory --mock read --conversation docs --after 12
```

`read` returns `conversation`, the current event cursor `seq`, and current copies of
`entries` touched by events strictly after `after`. A streaming reply can appear again
with updated text; merge entries by `id`, then advance the cursor. An empty result
returns immediately. Read from 0 to obtain the whole conversation. Conversations
default to `home`; `after` defaults to 0 and must be a nonnegative integer.

Work on VibeLang runs through its mythical history: epics of small commits, each with
notes on what was tried and what proves it. Read it, plan your task onto it, start it in
your lane, and note what you tried:

```sh
vibelang-factory --json history                          # epics and work not landed
vibelang-factory --json history --commit m4              # one commit's notes and real commits
vibelang-factory --json history --epic e4 --from 50      # an epic's commits, 50 at a time
vibelang-factory --json history --search "computed-key"  # commits by title
vibelang-factory plan "fix(compiler): ..." --epic e4 --task "issue 412"
vibelang-factory plan "docs: ..." --before m12           # insert; --amend m12 reopens a landed one
vibelang-factory start m5704 --lane my-lane
vibelang-factory note m5704 --section tried "A cache; it went stale."
```

Put `Mythical: <id>` in the commit message you enqueue, so the fold maps it back. You
never approve or fold: a person approves, and main folds in.

Use `--json` when consuming results as data. Successful commands exit 0; invalid
arguments, refused messages and unavailable backends exit nonzero with a plain error
on stderr. Do not interpret an unavailable live backend as a successful post. A
failed reply's reason (no model, a spent daily budget) is the agent's, not yours.
