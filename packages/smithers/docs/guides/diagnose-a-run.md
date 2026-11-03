---
title: "Diagnose a run"
description: "Work out why a run stopped: check the machine with doctor, read the status card, follow the transcript, print a node output, and file a bug with the digest attached."
---

Use `doctor` to inspect the local setup, then `runs show`, `runs logs`, and
`runs output` to read a run through the control plane. Those run commands also support
`--remote`.

## Is the machine ready?

```bash
smthrs doctor
```

`doctor` does not start a run. It reports the project root it resolved, how many flows
the registry discovered and one line per discovery warning, both database files
with how many migrations each has recorded, the running Node against the
supported range (22.19.0 or later), whether `jj` is executable,
which supported provider credential variables are set, and any Smithers 0.x
state beside the project.

Each check is `ok`, `warn`, or `fail`. A `warn` is a fact you should know that
stops nothing. A `fail` is a fact that will stop the next command you run, and
one `fail` makes `doctor` itself exit 1.

`--json` prints the report verbatim: an object with `root` and a `checks` array
of `{ name, level, detail }`. On a terminal the human rendering adds symbols
and a verdict line; on a pipe it is one line per check.

Reach for `doctor` when a flow discovers nothing, when a command wrote to a
database you did not expect, or when a launch is refused for a missing
credential.

## What happened to this run?

```bash
smthrs runs show <run-id>
```

`runs show` returns the run and its `diagnosis`, computed from the run's
journal events alone. It names the run by its flow: the engine runs every
planned flow inside an `agent/run` execution, and `runs show` reports that
wrapper under the flow's own name. `updatedAt` is the run's last recorded
progress; status-monitor checks do not advance it. `diagnosis.endedAt` stays
empty until the run settles. Validated native snapshots also supply execution
rows whose lifecycle records fall outside the journal window. Attached progress
counts scheduled work independently of its eight visible labels, and native
call outcomes correct earlier telemetry counts.

`health` is the run's health as the app's run card reads it: `health`,
`attention`, and `reason`. A run parked over executions its owner released
reports `attention: "needs-resume"` and lists them under `released`, each with
the `cause` its release recorded: `lease-lapsed` with `unconfirmedMs` when its
host stalled past the run lease, or `interrupted` for a shutdown. A release
recorded by an older build has no `cause`. Nothing
restarts them until `smthrs runs resume <run-id>`, which `runs show` offers
first among its next steps.

When the host that parked the run is still alive, such as a detached host whose
lease lapsed, `runs resume` hands the restart to that host rather than taking
the run. The host retries the released executions under the operator's permission.
The command returns once the host has taken the resume up and re-admitted the
released executions, and prints the receipt with `handedTo` and the run's new
`status`:

```json
{
  "_tag": "Accepted",
  "receiptId": "cli:resume:run-1:4:0b6c1e9e-5f3a-4f7e-9a51-2d0c8a6b3f10",
  "runId": "run-1",
  "handedTo": { "hostId": "mac", "pid": 78502 },
  "status": "parked",
  "waitingReason": "event"
}
```

If the host does not take it up within 15 seconds, the command fails with
`resume_not_taken_up` and names the host's process. The request stays recorded
for that process. If the process is stuck, stop it and run `runs resume`
again; a run whose host has exited is resumed by the command itself. Each `runs resume` is its own request, keyed to the park and the command: one killed before the run moved never makes a later one answer `AlreadyApplied`. Each
resume covers the releases that exist when the host takes it up, so a later
lapse needs another `runs resume`.

```text
runs show
runId: run-1
flowId: external-peer
status: parked
waitingReason: released
health
  health: awaiting-human
  attention: needs-resume
  reason: released
released
  1
    executionId: fad1…6e6c/worker
    flowName: external-peer/Worker
    cause: lease-lapsed
    unconfirmedMs: 20481
…
Next:
smthrs runs resume run-1
smthrs runs logs run-1 --format jsonl
```

`executions` lists what the run is doing: the run's own row first, then every
execution it spawned that is still live, then the latest settled ones, up to
20 rows (`executionsOmitted` counts the rest). Each row names the flow, its
status, the execution that spawned it, its round, its start and finish times,
and `running`, the actions it has scheduled and not yet settled:

```text
executions[2]{executionId,flowName,status,parent,round,startedAtMs,finishedAtMs,running}:
  run-1,parent,running,null,0,1790824422570,null,parent/Spawn
  1df0…/child,parent/child,running,run-1,0,1790824422810,null,parent/Hold
```

The rendered diagnosis card:

```text
Verdict   failed: Set OPENAI_API_KEY to run the openai:gpt-6-sol seat
Run       run-1 · hello · 0s
Trace     e83057ff72f0ed05c32463dd33e97d72
Activity  0 turns · 0 calls (0 refused, 0 duplicate) · edits 0/0
Tokens    0 in / 0 out
Cause     Set OPENAI_API_KEY to run the openai:gpt-6-sol seat
Next      smthrs runs logs run-1    # turn-by-turn transcript
```

Lines appear only when they have something to say. A run whose model calls
were priced gains a `Cost` line under `Tokens`: their USD total, each call at
its provider's reported charge or else its usage at the model's rate card. A
run with refused flow calls gains a `Refusals` line, aggregated by message with a count, which is
usually where a stuck agent's real problem is. A run Jev read memory for
gains a `Memory` line: the ids of the memory it was brought, then those
withheld as unneeded (`smthrs memory notes get <id>` shows one).
`smthrs runs show <run-id> --json` carries the same lists as
`diagnosis.memory`, and a client reads the same `relevance-settled` rows from
the run's `run-events` projection. A run that is still waiting
gains an `Unblock` line, and that line is the point of the card. It names
what ends the wait:

- A run parked on an approval:
  `smthrs approvals approve '<payload>' --scope run`, then
  `smthrs runs resume <run-id>`.
- A run parked over executions its owner released, which `runs list` lists as
  `parked` with `waitingReason: "released"`: `smthrs runs resume <run-id>`.
- A run no executor took, which `runs list` lists as `accepted` with
  `waitingReason: "executor"` and the card calls `pending`:
  `smthrs runs cancel <run-id>`, or run the flow from the host program that
  registers its delegates.

## Where did the time and tokens go?

```bash
smthrs runs show <run-id> --timing
```

`--timing` returns a timing report in place of the run card, computed from the
same journal events. A terminal shows tables in seconds; `--json` carries the
same facts in whole milliseconds. Usage matches its recorded step or native
execution; ambiguous legacy spend stays unattributed rather than being assigned
to a concurrent call.

```text
Run  run-1 · completed · 57.6 s wall · 2 model calls

Time
part           s      %
model       50.6   87.8
cells        5.4    9.4
judge        0.0    0.0
compaction   0.0    0.0
other        1.6    2.8
wall        57.6  100.0

Tokens
purpose  calls   input  cached  thinking  written  tokens  cost $
frame        2  18,632   6,272       286      846  19,764  0.0373
judge        1   3,069       —         —      239   3,308  0.0001
run          3       —       —         —        —  23,072  0.0374

Model calls (seconds)
#  frame  ask  purpose  start  total  wait  think  write
1      0    1    frame    0.9   23.3   7.3    5.2   10.6
2      1    1    frame   25.8   27.3   7.0    2.4   17.7

Wait by stage (seconds from the call's start)
#  signed   sent  headers  1st event  1st thinking  1st output   host
1   0.006  0.011    2.840      2.905         7.310      12.480  0.212
2   0.005  0.012    2.610      2.660         7.020       9.440  0.180
…
```

- `Time` splits the wall time into model wait, cells, judge, compaction, and
  other. The wall runs from the plan's creation, or from the run's first event
  when the store holds no plan record, to the run's last event, and the parts
  sum to it. `cells` is cell execution; the `Flow calls` line says how much of
  it was inside flow calls. `judge` is only the time a judge reading held the
  run up; a reading that settles beside a model call adds nothing.
- `Tokens` totals tokens and cost by purpose: `frame`, `compaction`, `judge`,
  `marks`, `claim`, `relevance`, and `reading`. The `run` row is their sum and
  matches the `Ledger` line.
- `Model calls` has one row per call. A re-ask of a frame is its own row with
  `ask` 2. A call that never settled reads `unsettled`, with the time until the
  event that ended it. `wait`, `think`, and `write` appear for calls whose
  settle record timed the stream. `Stream as the harness saw it` lists the
  harness's own readings (`stages` in the JSON) and `Wait by stage` the wire's
  (`timing`). Its `host` column is the time between the first output reaching
  the wire and reaching the harness; the `In host` and `Before sent` lines
  total that and the time before each request was sent. `Model call tokens`
  lists each call's input, cached, uncached, thinking, and written tokens, its
  tries, and whether its frame changed the workspace.
- `Frames` splits each frame the way `Time` splits the run. A frame whose
  `turn-closed` record carries its own split shows that split; its `judge` is
  what the loop waited on, and supervisor readings that ran beside the loop
  are in the `Judge` line's latency, so the two are not added.
- `Cell work` counts cells by what they amounted to (`calls`, `no_call`,
  `comment_only`, `threw`, `rejected`). A call whose cell made no flow call
  moved nothing.
- `Compactions` and `Judge readings that fired` list each one.
- `Speed` fits call time against thinking and written tokens by least squares:
  fixed seconds per call, milliseconds per token, and R². `Speed by stage`
  fits thinking (headers to first output) and writing (first to last output)
  apart from the wire's timing, with the mean wait for headers beside them.
- `Derived` names every number the report worked out because the journal did
  not record it.

To read a run copied from another machine, point `--root` at the directory
that holds its `.flows/control.db`. The report only reads; it creates and
migrates nothing.

```bash
smthrs runs show run-1 --timing --root ./trial/agent/workspace
```

## What happens to subprocesses after a crash?

The local control executor records agent shell and configured MCP subprocesses
in the execution journal. On normal shutdown it escalates termination after
two seconds if a child does not stop. After a crash, the next local control
executor startup checks those records and reaps verified children whose owner
has died. It leaves another live CLI's children alone and refuses to signal a
process whose identity it cannot verify.

Startup cleanup can therefore happen while running a local control command,
not only when resuming the crashed run. Remote clients do not reap local
processes. Cleanup does not undo filesystem writes or other completed effects.

## What did it do, step by step?

```bash
smthrs runs logs <run-id>              # the recorded events, then stop
smthrs runs logs <run-id> --follow     # the recorded events, then new ones until the run settles
smthrs runs logs <run-id> --json       # the raw event stream
```

The human rendering prints one line per step: each action a run or its spawned
executions start and settle, each spawned execution's start and outcome, agent
turns, and printed output. Without `--follow` it stops at the newest recorded
event and ends with `End of recorded events` and the run's state; a run that is
still live suggests `--follow`. With `--follow` it keeps printing until the run
settles or you press Ctrl-C, which stops watching and leaves the run running.
`--json` is the raw `ControlEvent` stream in both modes, byte stable for a
script.

A finite read retains at most 50,000 events and 16 MiB, with a 1 MiB cap on any
single event, and fails with a typed resource-limit error rather than
truncating. Follow mode applies the per-event cap without retaining history.

## What did a step produce?

```bash
smthrs runs output <run-id>             # every registered node output
smthrs runs output <run-id> result      # one node
```

`runs output` projects the node outputs a run registered. A node id the run does not
have is a usage error naming the run, not an empty document, so a script never
mistakes "no such node" for "no output".

Node outputs are caller-controlled data, so they are rendered through
`Output.renderValue`. That means a stored value shaped like a control receipt
cannot change the command's exit status.

Native journal projection follows the root, its durable children and trampoline
rounds until every observed execution is terminal. Detached descendants can still
publish output after the root completes. Terminal ordering waits at most its grace
period plus one grace period for the gap receipt; a blocked receipt logs a warning
and releases the terminal write. Operator error sentences and names, including
designed refusals, pass through diagnostic redaction and terminal sanitization.

Snapshot garbage collection refuses malformed live state before sweeping; a
legacy state object without an execution digest remains valid.

## Report it

```bash
smthrs bug "flow start hangs after the second turn" --run <run-id>
```

The summary may be quoted or supplied as separate words. Omitting it prompts on a TTY;
on a pipe, the CLI exits 2 before opening project state.

`bug` collects the context a maintainer always asks for: versions, platform,
only the named run and its event digest. Without `--run`, no runs are included. Everything it
collects passes through the journal's shared redaction rules before it leaves
the machine, and the report is refused outright if it contains a callable, a
proxy, a `toJSON` member, or a value past the walk limits, because those could
run code while the report is rendered.

The exact redacted JSON payload and endpoint are printed to stderr before any post.
Use `--dry-run` to inspect them without sending, including when `--yes` is also set.
Posting requires `--yes` or confirmation on an interactive TTY; declining or
omitting consent in a non-interactive session sends nothing and exits 2.

Reports go to `https://bug.smithers.sh/api/bugs` unless
`SMITHERS_BUG_ENDPOINT` names another one.

## See also

- [Output and exit codes](../concepts/output-and-exit-codes.md): the status
  each of these commands exits on.
- [Script the CLI](./script-the-cli.md): answering a park from a script.
- [CLI reference](../reference/cli/README.md): `smthrs runs` and `smthrs doctor`.

A terminal root is readable after its native result has been copied into the control journal. A detached child does not hold that read open; its later events keep flowing until it finishes. Rewinding the root requires fresh evidence from the new journal generation.

Bulk replay verification rebuilds changed source separately for each run in copied stores. Parked siblings in a copy do not block replay-only analysis. Live source adoption still refuses to replace a module used by another unfinished run.
