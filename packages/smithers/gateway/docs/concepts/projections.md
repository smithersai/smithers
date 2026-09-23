---
title: "Projections"
description: "Why the gateway serves folds over control events instead of database rows, what the eight projections answer, and how a node gets its id."
sidebar:
  order: 1
---

A projection is a read model: a row folded from the ordered `ControlEvent`
deltas [`@smthrs/control`](/api/control) already publishes, plus the run summary
the control plane already exposes. Subscribing to one never claims a run and
never writes.

The rule behind every design decision in this package is that the gateway never
opens the engine database. `Projections` reads through two control-plane
operations and nothing else: `Control.list` for run and flow listings, and
`Control.watch` for one run's ordered events. Two consequences follow, and both
are the point:

- A projection served to a browser through a relay is the same projection a
  local reader computes. There is no privileged path.
- A projection cannot drift from the control plane by reading a column the
  control plane does not expose, because it has no column to read.

That is why a UI depends on this package and on `@smthrs/control`, and never on
[`@smthrs/engine-store`](/api/engine-store). A projection is the contract; a
store row is an implementation detail.

## The eight projections

`GatewaySchema.ProjectionName` is the authority for the list, and the set a
release serves is the set the schema declares.

| Projection       | Selector                | Answers                                                                                         |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `workspace-runs` | `WorkspaceRunsSelector` | one summary row per run in the workspace                                                        |
| `run-summary`    | `RunSummarySelector`    | one run's card: status, timing, activity counts, and the diagnosis of what happened to it       |
| `run-events`     | `RunEventsSelector`     | the run's ordered control events, unfolded                                                      |
| `transcript`     | `TranscriptSelector`    | one turn-numbered line per reported event                                                       |
| `run-tree`       | `RunTreeSelector`       | the agent cell calls the run made, keyed `call-1`, `call-2`, and so on                          |
| `approvals`      | `ApprovalsSelector`     | with a run, that run's gates including decided ones; without one, the workspace's pending gates |
| `node-output`    | `NodeOutputSelector`    | the value one settled call produced                                                             |
| `flow-durations` | `FlowDurationsSelector` | how long one flow's nodes take, per action tag, over its newest finished runs                   |

`GatewaySchema.rowSchemaFor` maps a selector to the schema of the rows it
answers with, so a client decodes a snapshot instead of casting it.

## The rows speak the control plane's vocabulary

Wire names are the flows names. `RunSummaryRow.flowId` carries what an older
wire split across `workflowKey` and `workflow`; `createdAt` carries what it
called `createdAtMs`; `ApprovalRow.payload` is the `ApprovalTarget.Node`
envelope a client submits back unchanged. A client written against the control
plane reads these rows with no translation table, and no client reconstructs
authority for itself.

`ControlFacts.fold` is the shared run/approval fold used by both snapshots and
subscription deltas. Current control lifecycle writers include `factVersion: 1`
and the complete fenced control snapshot in the event. The first accepted
snapshot has a `created` baseline. The first upgraded transition of an older run
has a `legacy` baseline: it establishes state at that sequence and does not
invent the missing earlier history.

`RunSummaryRow.lifecycleProvenance` explains the boundary. `control: "events"`
means the latest versioned snapshot agrees with the current coordination row's
status and update time. `legacy-snapshot` means no versioned baseline is present.
`unverified-snapshot` means the row is ahead of the covered facts, a lifecycle
fact is missing, or a producer version is unknown. These last two cases retain
the observed row; they are never labelled successful replay. A later complete
snapshot begins a new legacy baseline after a gap.

Engine observations are independent: `execution: "engine-observed"` preserves
the status and waiting/ancestry fields `ControlLive` read from the executor;
`engine-missing` records that no execution was visible. Neither is claimed as
control-journal replay. No projection read writes a migration or acquires a run.
The field is optional on the wire for older gateway compatibility.

Current approval facts bind the full target, run, request, and digest. Duplicate
requests cannot reopen a decided gate; exact decisions can precede a request.
Legacy payloads remain readable, and an unnamed legacy decision can close only
a legacy request in that run. An unknown current identity never consumes another
gate. Serving historical approval content grants no authority: the control
decision endpoint still validates the exact target and principal.

## Committed flow results

`RunSummaryRow.finalOutput` prefers the assistant's final text. Otherwise it
uses the committed successful result of the `agent/run` execution named by
`control.engine.bound`. A matching `control.engine.event` must carry the
completed root's versioned run decision. Child results, unbound events, and
conflicting evidence do not supply output. Strings are preserved; other JSON
values are serialized. The binding and result survive in the carried diagnosis
when older events leave the retained window.

## How a node gets its id

`run-tree` folds agent cell calls, not child runs. A node opens on a call
invocation and settles on the matching recorded result. The native action owner
commits `flows.harness.call-fact.v1` inside its attempt transaction, then the
existing engine bridge copies it into `control.engine.event`. `Diagnosis`'s
shared `nativeCallEvent` and `uniqueCallEvents` normalize these facts with
compatible `control.agent.cell-call-started` / `cell-call-settled` telemetry.
`AgentSession` still emits the latter on its best-effort trace channel.
The normalized start carries `{callId, flowName, input}` and the settlement
carries `{callId, flowName, outcome, message, value}`. `callId` is
`cell-call-v1:` followed by the SHA-256 digest of the canonical JSON dispatch
identity: session, frame, cell digest, invocation ordinal, declaration digest,
and ordered active layers. The harness creates that identity before dispatch
and carries it unchanged into settlement. The same call keeps its identity
across replay, and two calls of the same flow can settle in either order.

The public node key remains the ordinal of each distinct start: `call-1`,
`call-2`, and so on. Identified settlements join by `callId`. Repeated starts
or settlements with the same ID contribute one observation to
the tree, node output, transcript, and diagnostic counts. A committed native
fact supersedes identified telemetry while retaining the first observation's
position and sequence, so existing node references remain stable. Without a
native fact, the first identified telemetry record remains the observation.
Transcript rows
expose the optional `callId`; `run-events` continues to expose every journal
record, including duplicates, for inspection.

Older records have no `callId` and are read without rewriting history. They
retain FIFO matching among **unidentified** starts with the same flow name.
An identified settlement may match an unidentified start when an older parked
run resumes with the new writer. Neither an unknown ID nor an unidentified
settlement can consume an identified start. A settlement with no eligible
start produces no node output. Correlation of overlapping, same-name legacy
calls cannot be recovered exactly from those old records.

`node-output` keys its rows the same way and advances its ordinal on exactly
the same distinct starts, so the node id a tree view shows is the node id
`node-output` answers for. The CLI/MCP node-output reader retains its existing
`flowName#ordinal` IDs, counting distinct starts within each flow, and uses
the same identity/legacy matching rule. A fold that skipped a distinct start
before advancing its ordinal would shift references to later nodes.

A node that never settled stays `running`, which is how a live tree renders
work in flight.

## A duration is measured, never estimated

`flow-durations` is the one projection that reads across runs. It lists the
flow's runs through `Control.list`, keeps the newest `Projections.maxDurationRuns`
that reached a terminal status, and folds each one's node records into samples.

A sample is one node the engine really ran: the distance between the
`flows.engine.node-scheduled` record that admitted it and the
`flows.engine.node-settled` record that closed it, both copied into the control
journal as `control.engine.event` envelopes by the host's engine bridge. Only
the `built` outcome counts. `clean` was served from records rather than run,
`failed` measures a collapse, `skipped` was never reached, and `deferred` is
scheduling debt, so none of them describes how long the work takes.

Samples are grouped by the node's action tag, because the tag is the part of a
node's key material that survives a re-key: the same step keeps its tag when
its input changes, and its plan key and dispatch key do not. Both percentiles
are nearest-rank, so `p50Ms` and `p90Ms` are durations the flow really took.
`samples` is on the wire beside them, because a percentile over one sample and
a percentile over twenty are different claims.

One call is one sample. The engine records a `FlowCall` twice: the caller
admits and settles the node that made the call, and the callee's own execution
admits and settles its `root` over the same span with the same tag. The fold
keeps the caller's node and drops the callee's root, which it can tell apart
because the host's `control.engine.bound` record names the native root the
control run owns. A run with no such record, such as one no engine bridge
wrote, keeps both: a fold that cannot name the root cannot name the echo
either.

A duration is wall time between two engine records, so a node that waits is
measured through its wait. A flow tag whose flow parks on a `HumanTask`
measures the park, and so does every flow tag above it. These rows answer how
long the flow took, not how much compute it spent.

A tag nothing has measured has no row, and a flow nothing has finished answers
with no rows at all. There is no shape here for an unmeasured prediction.

## What is not in a projection

A host keeps the control plane and the engine in two databases with two
journals. `Control.watch` reads one run's control partition; the gateway does
not open the native database. Native call and execution facts become readable
through the durable engine bridge, which can lag its source. Other engine
records remain inspection material unless a specific pure fold recognizes
their versioned producer contract. Model deltas and printed trace text still
have best-effort delivery; call fact coverage does not make the entire trace
replayable. Public values are redacted and bounded commitments, not private
native outcome rows.

## The folds are pure and total

`GatewayProjection.runSummary`, `runTree`, `approvals`, `nodeOutput`, and
`transcript` are ordinary functions from control facts to rows. They read no
service, and an event kind outside their vocabulary contributes nothing rather
than failing the fold. Wire payloads are JSON, so every field read tolerates
absence: the digest of a malformed journal is a sparse digest, never a throw.

That purity is what makes a delta trustworthy. A subscription recomputes the
selector's rows from accumulated events rather than patching them, and
recomputation is only safe because the same events always fold to the same
rows. `run-events` sends only what one event added. `transcript` normally does
the same, but a later native fact can correct previously emitted telemetry. It
then sends the existing `snapshot-start` / `row` / `snapshot-end` reset so the
subscriber converges to a fresh fold at the same cursor. See
[Subscriptions and cursors](./subscriptions.md).

## What a projection costs

A projection reads one journal per run, so the read is bounded on purpose:

| Bound                            | Value  | What it caps                                                                |
| -------------------------------- | ------ | --------------------------------------------------------------------------- |
| `Projections.maxWorkspaceRuns`   | 500    | runs one workspace projection folds, newest first                           |
| `Projections.maxEventsPerRun`    | 10,000 | retained events per run                                                     |
| `Projections.maxEventsPerPage`   | 1,000  | events per `run-events` page                                                |
| `Projections.maxEventBytes`      | 16 KiB | retained event size before clipping                                         |
| `Projections.maxProjectionBytes` | 4 MiB  | retained events and digest identity state, event page, or projected row set |

`maxWorkspaceRuns` equals `ControlSchema.maxPageSize`, so the control plane can
satisfy the whole gateway allowance in one page when it can. A workspace with
more runs is answered with its newest 500. Older retained events are folded into
a carried digest. Compact scalar contributions retain call and checkpoint
identities so replay is counted once and committed native facts can correct
earlier telemetry across the window boundary. These contributions share the
retained byte budget; their inputs, outputs, and event bodies are not retained.
If the exact identity state or a projected row set cannot fit, the read fails
with `resource_limit`.

`run-events` pages preserve complete `control.engine.event` payloads, including
native typed results, without the 16 KiB clipping applied to other large events.
A page stops at its event or byte budget and returns a cursor. One event whose
encoded size plus array brackets exceeds 4 MiB fails with `resource_limit`.

The approvals inbox is the one workspace projection that filters before it
counts: it asks the control plane for runs whose status is `waiting-approval`,
and admits only runs still in that status with at least one pending gate after
reconciling their journals. Snapshot admission and live refresh use the same
predicate: cancellation removes a run even when its gate remains pending.
A run with no pending gate does not consume the source allowance. An inbox
cannot be exhausted by completed histories.

Native lifecycle uses an independent `ExecutionFact` fold over the host-bound
engine bridge. Run rows may include `executionProvenance` (`events`,
`legacy-observation`, or `unverified-observation`) alongside the existing
`lifecycleProvenance`; engine replay does not become control-stream authority.
The fold verifies the native root/current-round view against the executor's
coherent observation. A missing binding, native generation gap, unsupported
version, or differing observation retains explicit fallback. Snapshot and
subscription paths share this fold. The protected native wait token remains in
the execution store; the event carries its SHA-256 digest for comparison.
