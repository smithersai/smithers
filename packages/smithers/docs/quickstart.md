---
title: "Quickstart"
description: "Scaffold a project, plan a flow, approve the plan, run it, and read the run back, using the smthrs command line end to end."
sidebar:
  order: 2
---

This quickstart takes one directory from empty to a settled run. Every command
here is a real `smthrs` process against one real project.

By the end you will have a project with `.flows/control.db` and
`.flows/engine.db` on disk, one flow discovered from `.smithers/flows/`, and one durable
run you can list, read, and delete.

## Before you start

Install the CLI and check the machine, as described in
[Installation](./installation.md):

```bash
mkdir hello-smithers && cd hello-smithers
smthrs doctor
```

`doctor` inspects discovery and existing state without creating execution databases. It reports the project root it resolved, both database
files, the supported Node range (22.19.0 or later), whether `jj` is on the
`PATH`, and which provider keys are set. A `fail` line is a fact that will stop
the next command you run; fix those first.

## Scaffold a flow

```bash
smthrs init hello
```

`init` creates workspace declarations, a package manifest when absent, and
`.smithers/flows/hello/flow.ts`. Existing declarations and any single `flow.ts`,
`flow.mdx` or `SKILL.md` entry are retained. Conflicting entry files are refused.
It adds `.flows/` to `.gitignore` in a repository; execution databases are acquired by runtime
commands, not by generating a flow.

For an existing npm or Bun workspace, use the supported flow-only path:

```bash
smthrs generate flow hello
```

This preserves `packageManager` and adds the flow without inventing an npm
workspace executor. `init` refuses an unsupported package manager before
writing project files and points to this command. A `bun@` manager is refused
the same way, because Smithers cannot install `node_modules` with Bun; write
`WORKSPACE.ts` by hand to run tools under Bun.

The starter default-exports `Flow.make("hello", { ... })` from `@smthrs/flow`:
its tag matches the directory name. Its body plans one `AgentAction`, and its
named `layer` exports that action's implementation for the existing host.

```ts
export const layer = Work.layer
export default Flow.make("hello", {
  description: "A starter Smithers flow.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  model: "anthropic:claude-sonnet-4-5",
  payload: { args: Schema.optional(Schema.String) },
  success: Schema.Struct({ summary: Schema.String }),
  error: AgentAction.AgentFailure,
  body: Node.capture({ action: Work.name }, (input) => Work.call(input))
})
```

The generated file includes the imports and `Work` declaration. With no `args`,
it summarizes the project and suggests one small improvement. Pass work through
`--data '{"args":"Your request"}'`; the result is `{ "summary": "..." }`.
Narrow the file, process and model capabilities when the work needs less authority.

`init` chooses a model seat from the provider credentials this environment sets,
in the order `doctor` reports them. Edit both `Work`'s `seat` and the flow's
`model` to choose another. Credentials stay in the environment.

For a Codex subscription:

```bash
codex login --device-auth
export SMITHERS_OPENAI_AUTH=chatgpt
```

For Codex, use `openai:gpt-6.1-sol` for both fields. For a Claude subscription, run
`claude auth login` and use `opus` for both fields; with `ANTHROPIC_API_KEY` unset the
seat runs on your own Claude Code, and with it set, on the Anthropic API. Team hosts use
their connected accounts.

The host picks the completion judge from what it holds:

| The host holds                                                                 | Judge                              |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| `AI_GATEWAY_API_KEY`                                                           | Jev, through the Vercel AI Gateway |
| No key, and a signed-in Claude Code with `ANTHROPIC_API_KEY` unset             | Claude Haiku on that Claude Code   |
| No key or Claude Code, and the Codex subscription above or a team account pool | GPT-6 Luna on that subscription    |
| None of these                                                                  | None: the run fails `unconfigured` |

A host with both subscriptions judges on Claude Haiku. With a key, a
subscription judges only while Jev is unreachable, times out, or answers 5xx
or 429. A provider API key never judges. Refusals and invalid judgments fail
the run without a fallback.

Confirm the flow is discoverable:

```bash
smthrs flow list
```

```text
{
  "_tag": "flows",
  "items": [
    {
      "flowId": "hello",
      "description": "A starter Smithers flow.",
      "inputSchema": {
        "dialect": "draft-2020-12",
        "schema": {
          "type": "object",
          "properties": {
            "args": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "additionalProperties": true
        },
        "definitions": {}
      }
    }
  ]
}
```

`inputSchema` is the starter's declared payload. Input is decoded against it
before a run exists, so `--data '{"args":42}'` is refused by `flow plan`.

## Plan the flow

```bash
smthrs flow plan hello
```

`flow plan` creates no run. It asks the control plane to plan the flow and prints
the plan card: the plan id, the content digest, the canonical summary of the
input, the capability envelope, the node graph, and an `approval` member. That
`approval` member is the payload `approvals approve`, `approvals deny`, and `flow execute` accept
unchanged.

Capture it for the next two steps:

```bash
approval="$(smthrs flow plan hello --json | jq -c '.approval')"
```

## Submit it, and watch it park

```bash
smthrs flow execute "$approval"
echo "exit: $?"
```

```text
{"_tag":"Parked","planId":"<plan-id>","receiptId":"<receipt-id>","status":"waiting-approval"}
exit: 3
```

The plan carries no grant yet, so the control plane parks it instead of
launching. Exit 3 is the one outcome a caller cannot read from the payload
alone: the run did not fail, it is waiting for a decision.

## Approve it, then run it

```bash
smthrs approvals approve "$approval" --scope run
```

```text
{"_tag":"Accepted","receiptId":"approve:plan-1"}
```

`approvals approve` records the grant. It does not launch: the receipt carries no
`runId`, and `smthrs runs list` still lists nothing. Submit the same payload again,
and this time the grant is there:

```bash
smthrs flow execute "$approval"
echo "exit: $?"
```

`--scope run` grants this launch and the whole run it starts, which is the same
grant `smthrs flow start` makes for itself. `once` grants a single ask, and
`remembered` grants every later run.

Because this process owns the executor, `flow execute` stays attached after the receipt
is accepted, waits for the run to settle, and reports the run's outcome as its
own exit status: 0 for `completed`, 1 for `failed`, 130 for `cancelled`, 3 if
it parks again on an in-run ask.

With no resolvable provider credential, the run settles `failed` and its
`cause` names the key to set:

```text
{"_tag":"Accepted","cause":"Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat","receiptId":"approve:plan-1","runId":"run-1","status":"failed"}
```

## Read the run back

```bash
smthrs runs list
```

`runs list` lists durable runs with their status, and `--status` filters on the seven
statuses the release pins: `accepted`, `running`, `parked`,
`waiting-approval`, `cancelled`, `completed`, and `failed`. An eighth value is
a usage error, not an empty list. A listing is one page of 100 runs; when more
remain it prints `nextCursor`, and `--cursor <nextCursor>` reads the next page.
`--limit` sets the page size, from 1 to 500. `--since` and `--until` bound the
creation time (epoch milliseconds or ISO 8601; `--until` is exclusive),
`--sort newest|oldest` orders by it, and `--parent <run-id>` and
`--trigger <trigger-id>` select a run's branches or a trigger's runs.
`smthrs runs count` takes the same filters and prints how many runs match.

Take the run id from that listing and read what happened:

```bash
smthrs runs show <run-id>     # the diagnosis: what it did, and what to do next
smthrs runs logs <run-id>     # the transcript; --json is the raw event stream
smthrs runs output <run-id>   # every registered node output
```

`runs logs --follow` streams events as they land instead of rendering a transcript.
`runs output <run-id> <node-id>` prints one node's output; a node id the run does
not have is a usage error naming the run, not an empty document.

## Do it in one command next time

The plan, approve, execute sequence collapses into one command when the plan needs no
human review:

```bash
smthrs flow start hello --data '{"args":"Describe how durable runs work"}'
```

`flow start` plans the flow, grants the plan's own approval at `run` scope, and submits
it. Attached, it waits for the run to settle and exits with the run's status.
With `-d` it launches a child process that outlives it and prints the run id
and log path instead. See [Launch a detached run](./guides/launch-a-detached-run.md).

## Clean up

```bash
smthrs runs cancel-all                 # cancel every non-terminal run
smthrs gc --older-than 1s --dry-run    # report what retention would delete
smthrs gc --older-than 1s              # delete it
```

`runs cancel-all` is a list followed by a cancel, so running it twice is a no-op rather
than an error. `gc` refuses `--older-than 0s`: deleting everything is not a
retention policy, and it is the easiest value to type by accident.

## What just happened

One project directory anchored every command on the same two SQLite files, so
the run `flow execute` started is the run `runs list` listed and `gc` deleted.
The approval you passed to `flow execute` and `approvals approve` was the same
serialized payload `flow plan` printed,
which is why another local operator process or explicitly delegated remote
operator can decide a park this shell created. The MCP surface can inspect
pending approvals but refuses approval and denial decisions.

## Next steps

[Change your code with a flow](./guides/change-code.md), review the diff, and commit and push it yourself.

- [Script the CLI](./guides/script-the-cli.md): `--json`, exit codes, and the
  idempotency keys that make a retried command safe.
- [Diagnose a run](./guides/diagnose-a-run.md): what `status`, `logs`, and
  `output` each answer, and how to file a bug with a run digest attached.
- [Output and exit codes](./concepts/output-and-exit-codes.md): the rendering
  rules and the status vocabulary a script branches on.
