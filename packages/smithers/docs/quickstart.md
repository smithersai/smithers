---
title: "Quickstart"
description: "Hands-on CLI tutorial: scaffold a flow, inspect its plan, watch it park for approval, grant the scope, execute it durably, and read the journal back."
sidebar:
  order: 2
---

An ordinary shell script runs immediately and forgets everything the moment it exits. A Smithers flow **plans first**, **parks for approval**, **executes durably into SQLite**, and stays inspectable long after the process ends.

In this tutorial you will walk one empty directory through the entire `smthrs` control-plane loop so you can see every moving part before collapsing it into a single command.

```text
smthrs init hello
       |
       v
smthrs flow plan hello  ----->  prints PlanCard + approval payload (0 steps run)
       |
       v
smthrs flow execute "$approval"
       |
       +-- no grant yet  --->  Parks (exit 3, status: waiting-approval)
       |                              |
       |                              v
       |                       smthrs approvals approve "$approval" --scope run
       |                              |
       +-- grant present <------------+
       |
       v
Runs durably (.flows/control.db + .flows/engine.db) -> smthrs runs show / logs / output
```

## 1. Check the machine

Install `smthrs` as shown in [Installation](./installation.md), create a workspace directory, and run `doctor`:

```bash
mkdir hello-smithers && cd hello-smithers
smthrs doctor
```

`smthrs doctor` checks the project root, database state, Node.js version (22.19.0+), `jj` on `PATH`, and available model providers without creating any databases. Fix any `fail` line before proceeding.

## 2. Scaffold and inspect a starter flow

```bash
smthrs init hello
```

`init` creates workspace declarations, a `package.json` if missing, `.smithers/flows/hello/flow.ts`, and adds `.flows/` to `.gitignore`. Existing declarations and single `flow.ts`, `flow.mdx`, or `SKILL.md` files are kept; conflicting entry files are refused.

> **Using npm or Bun?** Run `smthrs generate flow hello` instead. That preserves `packageManager` without creating an unsupported workspace executor. (`init` refuses `bun@` and npm package managers before writing anything because Smithers' workspace installer targets pnpm; write `WORKSPACE.ts` by hand to run tools under Bun.)

Open `.smithers/flows/hello/flow.ts`. Its default export declares the flow's tag (matching its folder), capabilities, effects, schemas, and body, while `export const layer` supplies the action's implementation:

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

Tighten `capabilities` whenever a flow needs less authority. Pass input via `--data '{"args":"Your request"}'`; with no `args`, the starter summarizes the directory and suggests one small improvement.

### Choose a subscription or API key

`init` picks a seat from credentials already set in your shell (in `doctor` order). To change seats, update both `Work`'s `seat` and the flow's `model` while keeping secrets in environment variables:

- **Codex subscription:** set both fields to `"openai:gpt-6.1-sol"`, then run `codex login --device-auth` and `export SMITHERS_OPENAI_AUTH=chatgpt`.
- **Claude subscription:** set both fields to `"opus"`, run `claude auth login`, and leave `ANTHROPIC_API_KEY` unset (setting `ANTHROPIC_API_KEY` switches to the Anthropic API).

The host picks its completion judge automatically:

| Available on host | Judge selected |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Jev via Vercel AI Gateway |
| Signed-in Claude Code (`ANTHROPIC_API_KEY` unset) | Claude Haiku on Claude Code |
| Codex subscription (`SMITHERS_OPENAI_AUTH=chatgpt`) or team account pool | GPT-6 Luna on that subscription |
| None of the above | None (run fails `unconfigured`) |

With both subscriptions present, Claude Haiku takes priority. With `AI_GATEWAY_API_KEY` set, a subscription steps in only when Jev is unreachable, times out, or returns 5xx/429. Provider API keys never judge, and refusals or invalid judgments fail without fallback.

Verify discovery:

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

Because inputs validate against `inputSchema` before a run exists, invalid data like `--data '{"args":42}'` fails immediately at `flow plan`.

## 3. Plan first (zero side effects)

```bash
smthrs flow plan hello
```

`flow plan` creates **no run** and runs **no steps**. It prints a `PlanCard` containing the plan ID, content digest, canonical input summary, capability envelope, node graph, and an `approval` token.

Save that `approval` payload to reuse unchanged in the next steps:

```bash
approval="$(smthrs flow plan hello --json | jq -c '.approval')"
```

## 4. Execute without a grant, and watch it park

Try executing the plan before approving it:

```bash
smthrs flow execute "$approval"
echo "exit: $?"
```

```text
{"_tag":"Parked","planId":"<plan-id>","receiptId":"<receipt-id>","status":"waiting-approval"}
exit: 3
```

> **Why exit code `3` instead of `1`?**
> Exit `1` means the run failed. Exit `3` tells scripts and CI pipelines that nothing broke: the control plane deliberately **parked** the plan waiting for a human decision.

## 5. Approve the plan, then execute it

Record a run-scoped grant for that exact plan payload:

```bash
smthrs approvals approve "$approval" --scope run
```

```text
{"_tag":"Accepted","receiptId":"approve:plan-1"}
```

Notice there is no `runId` yet: approving records permission, it does not launch execution (`smthrs runs list` is still empty). Scope choices are `once` (single ask), `run` (this launch and its run), and `remembered` (future runs too).

Now submit the exact same `$approval` payload again:

```bash
smthrs flow execute "$approval"
echo "exit: $?"
```

This time the grant matches. `flow execute` attaches to the local executor, waits for settlement, and mirrors the run's outcome in its exit code (`0` completed, `1` failed, `130` cancelled, `3` parked on an in-run ask).

If no provider credential is configured, the run fails cleanly and names the missing credential:

```text
{"_tag":"Accepted","cause":"Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat","receiptId":"approve:plan-1","runId":"run-1","status":"failed"}
```

## 6. Read the durable record back

Everything that happened sits in `.flows/control.db` and `.flows/engine.db`. Query it anytime:

```bash
smthrs runs list
```

Useful filters on `runs list` (and `runs count`, which takes the exact same flags):

| Flag | Behavior |
| --- | --- |
| `--status <state>` | Filter by `accepted`, `running`, `parked`, `waiting-approval`, `cancelled`, `completed`, or `failed` (unknown values error) |
| `--limit <1..500>` / `--cursor <token>` | Paginate runs (default page size `100`) |
| `--since` / `--until` | Creation-time bounds (epoch ms or ISO 8601; `--until` is exclusive) |
| `--sort newest\|oldest` | Order results by creation time |
| `--parent <run-id>` / `--trigger <trigger-id>` | Filter child branches or trigger runs |

Inspect a single run from three angles:

```bash
smthrs runs show <run-id>     # diagnosis: status, failure cause, next action
smthrs runs logs <run-id>     # human transcript (--json for raw events, --follow to stream)
smthrs runs output <run-id>   # every registered node output (or add <node-id> for one)
```

## 7. Next time: collapse steps 3-5 into one command

When a plan does not need a separate manual approval handoff, `flow start` plans, grants `--scope run`, and executes in one shot:

```bash
smthrs flow start hello --data '{"args":"Describe how durable runs work"}'
```

Add `-d` to detach into a background child process that prints the run ID and log path immediately. See [Launch a detached run](./guides/launch-a-detached-run.md).

## 8. Clean up

```bash
smthrs runs cancel-all                 # idempotent: safe to run twice
smthrs gc --older-than 1s --dry-run    # preview retention deletions
smthrs gc --older-than 1s --yes        # delete terminal records older than 1s
```

`gc` refuses `--older-than 0s` to prevent accidental wipeouts.

## Mental model recap

- Every command in this directory spoke to the same two SQLite files under `.flows/`.
- Because the `approval` token from `flow plan` is self-contained, a different local shell or an explicitly delegated remote operator can approve a run that another process parked. (The MCP surface can inspect pending approvals, never approve or deny them.)

## Next steps

- Put a coding agent to work on real code: [Change your code with a flow](./guides/change-code.md).
- Automate `smthrs` in scripts and CI: [Script the CLI](./guides/script-the-cli.md) and [Output and exit codes](./concepts/output-and-exit-codes.md).
- Debug failures and collect run digests: [Diagnose a run](./guides/diagnose-a-run.md).
