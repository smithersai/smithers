---
name: vibelang-factory
description: Talk to the VibeLang factory agent and read conversations through its Factory CLI.
---

Use `vibelang-factory` to work with vibelang.smithers.sh's Factory service. Run
`vibelang-factory --llms` first for the current command names and exact input/output schemas.
Use `--help` or `ask --help` for CLI syntax. From this app checkout, `pnpm cli ...`
builds and runs the CLI; the package bin points to its emitted executable.

Until the live backend is deployed, pass `--mock` or set `VIBELANG_FACTORY=mock`.
Without either, commands fail with `LiveBackendNotDeployed`. Mock mode uses the real
conversation state machine and scripted replies, with no server or model. Mock data
lasts for one process: separate CLI calls start empty. To share a mock conversation
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

Use `--json` when consuming results as data. Successful commands exit 0; invalid
arguments, refused messages and unavailable backends exit nonzero with a plain error
on stderr. Do not interpret an unavailable live backend as a successful post.
