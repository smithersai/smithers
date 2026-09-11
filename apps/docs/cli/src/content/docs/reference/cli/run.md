---
title: "smthrs run"
description: "Compatibility reference for approved flow payloads and parked-run resumption."
area: cli
order: 10
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/reference/cli/run.md"
---

Top-level `smthrs run <pattern>` now executes run-kind `PACKAGE.ts` targets.
This page documents the retained JSON-payload and `--resume` compatibility
forms. New scripts should use `smthrs flow execute <payload>` and
`smthrs runs resume <run-id>`. See the [CLI index](/reference/cli/) for target
execution and the canonical command groups.

## Compatibility synopsis

```text
smthrs run PLAN_PAYLOAD
smthrs run --resume RUN_ID
```

## Description

`smthrs run` submits the serialized approval payload that `smthrs plan`
printed and prints the control receipt. `resume` is an alternate spelling: the
command tree registers a hidden `smthrs resume RUN_ID` that runs the same
handler as `smthrs run --resume`.

The command plans nothing and approves nothing. A payload whose target is not a
plan is rejected, and a plan that carries no approval grant parks instead of
launching: the receipt reads `Parked` and the process exits 3.

When this process owns the executor, `smthrs run` stays attached after the
receipt is accepted and waits for the run to settle, then reports the run's
outcome as its own exit status. A `--remote` composition owns no executor, so
it prints the receipt and returns without waiting.

## Arguments

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `PLAN_PAYLOAD` | `string` | Yes | The serialized approval payload, the `approval` member of a plan card. With `--resume`, the same position carries the run id instead. |

## Flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--resume` | `boolean` | `false` | Read the argument as a run id and resume that run rather than launching a payload. |

## Global flags

`smthrs run` accepts `--root`, `--remote`, `--json`, `--quiet`,
`--mcp-config`, and `--log-level`, listed in the
[CLI reference index](https://smithers.sh/docs/reference/cli/). It reads the bearer from `SMITHERS_API_KEY`.
`--credential` is a compatibility flag that warns on stderr because process listings and shell history expose its value.

## Output

`smthrs run` prints one control receipt on stdout. Object members are ordered
by UTF-16 code unit, the human rendering indents two spaces per level, and
`--json` prints the same document with no whitespace. The receipt is one of
five tagged shapes: `Accepted` with `receiptId` and `runId`, `AlreadyApplied`
with the same two members, `Parked` with `receiptId`, `planId`, and
`status: "waiting-approval"`, `Conflict` with `message`, or `Terminal` with
`runId` and `status`.

For both launch and resume, the local receipt is printed after settlement,
not when admission succeeds. A failed settlement adds `status: "failed"` and
`cause` to that receipt. Progress can appear on stderr while stdout waits.
Use `smthrs up -d` when a new local launch needs its run id at admission;
[detached launches](/guides/launch-a-detached-run/) return the run id and
log path without waiting for settlement. Remote calls print the receipt without
a settlement wait.

When the executor declines an accepted run, the command prints the run summary
instead of the receipt, then fails with a sentence that names the run, its
status, and `smthrs cancel <run-id>` as the way to end it. A failed settlement
watch or interruption can end the command before any receipt is printed.

`--quiet` suppresses banners and progress on stderr, but this document still
prints.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The receipt was `Accepted` or `AlreadyApplied` and, when this process waited, the run settled `completed`. |
| `1` | The run settled `failed`, the receipt was `Conflict` or `Terminal` with status `failed`, the executor declined the accepted run, `--backend` or `SMITHERS_BACKEND` named a backend other than `sqlite`, or the control plane refused the mutation (run or plan not found, plan denied, digest or envelope mismatch, claim lost, launch failed, persistence failure, unavailable). |
| `2` | The payload is not valid JSON, does not match the approval schema, or targets a node rather than a plan (`run requires a plan approval payload`); or the command line failed to parse. |
| `3` | The receipt was `Parked`, or the run settled at `waiting-approval`. |
| `130` | The run settled `cancelled`, the receipt was `Terminal` with status `cancelled`, or the process received `SIGINT`. |
| `143` | The process received `SIGTERM`. |

## Example

Launch a plan payload that `smthrs approve` has already granted:

```bash
approval="$(smthrs --json plan deploy/status | jq -c '.approval')"
smthrs --json approve "$approval" --scope run
smthrs --json run "$approval"
```

After a successful local settlement, the accepted receipt uses this shape:

```text
{"_tag":"Accepted","receiptId":"<receipt-id>","runId":"<run-id>"}
```

After a failed local settlement, stdout retains the identifiers and adds the
failure verdict; the process exits 1:

```text
{"_tag":"Accepted","cause":"fixture failure","receiptId":"<receipt-id>","runId":"<run-id>","status":"failed"}
```

## See also

- [`smthrs plan`](https://smithers.sh/docs/reference/cli/plan/) produces the payload this
  command takes.
- [`smthrs approve`](https://smithers.sh/docs/reference/cli/approve/) grants the payload so a
  submission launches instead of parking.
- [`smthrs up`](https://smithers.sh/docs/reference/cli/up/) performs plan, approve, and run in
  one call.
- [`smthrs ps`](https://smithers.sh/docs/reference/cli/ps/) lists the run this command started.
- [Plan, approve, run](https://smithers.sh/docs/guides/plan-approve-run/) shows the procedure.
