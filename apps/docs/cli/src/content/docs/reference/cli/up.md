---
title: "smthrs up"
description: "Plan, approve, and run one flow; -d launches it detached"
area: cli
order: 20
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/reference/cli/up.md"
---

## Synopsis

```text
smthrs up FLOW_ID [--data JSON] [--detached]
```

## Description

`smthrs up` plans one flow, grants the plan's own approval at `run` scope,
and submits it, in one invocation. The approval authorizes this launch and its
whole run, not every future launch of the flow.

Without `--detached` the command stays attached: it prints the launch receipt,
waits for the run to settle when this process owns the executor, and reports
the run's outcome as its own exit status. With `--detached` it re-executes the
CLI as `smthrs run <payload>` in a process of its own, waits for that child
to prove the run row is durable, then prints the run id and the child's log
path. The child runs with the project root as its working directory and
inherits this process's environment; of the flags, only `--mcp-config`
(resolved to an absolute path) and `--root` are passed through.

A flow id that starts with `system/` is refused, because the control catalog
reserves those ids and 1.0.0-rc.0 ships a body for none of them. `--detached`
is refused alongside `--remote` or `SMITHERS_REMOTE`, because a detached launch
spawns a local executor. `smthrs up` takes no `KEY=VALUE` positional entries;
`--data` is its only input channel.

## Arguments

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `FLOW_ID` | `string` | Yes | The flow to plan and run, spelled as `smthrs ls` lists it. |

## Flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--data` | `string` | None | A JSON document decoded as the flow's input. A JSON object becomes the input members; any other JSON value lands under the key `data`. |
| `--detached`, `-d` | `boolean` | `false` | Launch the run in a process that outlives this one, and print the run id and log path instead of the receipt. |

## Global flags

`smthrs up` accepts `--root`, `--remote`, `--json`, `--quiet`,
`--mcp-config`, and `--log-level`, listed in the
[CLI reference index](https://smithers.sh/docs/reference/cli/). It reads the bearer from `SMITHERS_API_KEY`.
`--credential` is a compatibility flag that warns on stderr because process listings and shell history expose its value.

## Output

An attached launch prints one control receipt, the same document
`smthrs run` prints: `Accepted` with `receiptId` and `runId`,
`AlreadyApplied` with the same two members, `Parked` with `receiptId`,
`planId`, and `status: "waiting-approval"`, `Conflict` with `message`, or
`Terminal` with `runId` and `status`. Members are ordered by UTF-16 code unit,
the human rendering indents two spaces per level, and `--json` prints the same
document with no whitespace.

A detached launch prints a three-member document instead: `detached`, always
`true`; `logFile`, the absolute path `<project-root>/.flows/logs/<run-id>.log`;
and `runId`, taken from the child's own admission line. There is no `--run-id`
flag, so that document is where a caller learns which run started.

The detached child writes everything else to that log, including the launch
sentence for a run no executor takes. While the child is still proving
admission, its output lands in `.flows/logs/pending-<nonce>.log`, which is
renamed onto the run id once the admission line appears. A child that is silent
past `SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS` (30000 milliseconds by default)
but still alive prints a slow-boot line to stderr and is granted four times
that window before the launch is reported as failed.

`--quiet` suppresses banners and progress on stderr, but this document still
prints.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The launch was accepted and, when this process waited, the run settled `completed`; or the detached child reached admission. |
| `1` | The run settled `failed`, the receipt was `Conflict` or `Terminal` with status `failed`, the executor declined the accepted run, the flow id names a reserved `system/` flow, `--detached` was combined with a remote control plane, the detached child never reached admission, `--backend` or `SMITHERS_BACKEND` named a backend other than `sqlite`, the control plane refused the plan, approval, or launch, or one of the removed 0.x flags was passed: `--serve`, `--interactive`, `--supervise`, `--herdr`, `--monitor`, `--report`, `--force`, `--steal-ownership`, `--resume-claim-owner`, `--resume-claim-heartbeat`, `--resume-restore-owner`, `--resume-restore-heartbeat`, or `--max-concurrency`. |
| `2` | `--data` is not valid JSON, or the command line failed to parse. |
| `3` | The receipt was `Parked`, or the run settled at `waiting-approval`. |
| `130` | The run settled `cancelled`, the receipt was `Terminal` with status `cancelled`, or the process received `SIGINT`. |
| `143` | The process received `SIGTERM`. |

Each removed flag exits 1 with a sentence naming its replacement and a link to
`https://smithers.sh/migration/1.0`, never with a usage error.

## Example

Launch the `deploy/status` flow detached and read back its machine document:

```bash
smthrs up deploy/status --data '{"branch":"main"}' -d --json
```

The compact document, with a run id and project root standing in for yours:

```text
{"detached":true,"logFile":"/srv/deploy/.flows/logs/run-01J9.log","runId":"run-01J9"}
```

For a scripted launch using a previously planned `approval` payload, handle a
`Parked` receipt with the same approve-then-launch sequence as `up`. Plan
approval records the grant but starts no run. Submit the same payload with
`flow execute`, retaining its `idempotencyKey`:

```bash
status=0
receipt="$(smthrs flow execute "$approval" --json)" || status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 3 ]; then
  exit "$status"
fi
if [ "$(printf '%s' "$receipt" | jq -r '._tag')" = "Parked" ]; then
  smthrs approvals approve "$approval" --scope run --json
  receipt="$(smthrs flow execute "$approval" --json)"
fi
```

An in-run Node approval instead resumes its existing run. See
[Script the CLI](/guides/script-the-cli/#answer-a-park) for extracting
the nested approval payload from its event.

## See also

- [`smthrs plan`](https://smithers.sh/docs/reference/cli/plan/) performs the planning half
  alone.
- [`smthrs run`](https://smithers.sh/docs/reference/cli/run/) submits a payload that is already
  approved, and resumes a parked run.
- [`smthrs logs`](https://smithers.sh/docs/reference/cli/logs/) reads the events of the run this
  command started.
- [`smthrs cancel`](https://smithers.sh/docs/reference/cli/cancel/) ends a run no executor
  takes.
- [Plan, approve, run](https://smithers.sh/docs/guides/plan-approve-run/) shows the procedure.
