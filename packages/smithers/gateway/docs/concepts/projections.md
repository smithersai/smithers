---
title: "Projections"
description: "Why the gateway serves folds over control events instead of database rows, what the seven projections answer, and how a node gets its id."
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

## The seven projections

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

`GatewaySchema.rowSchemaFor` maps a selector to the schema of the rows it
answers with, so a client decodes a snapshot instead of casting it.

## The rows speak the control plane's vocabulary

Wire names are the flows names. `RunSummaryRow.flowId` carries what an older
wire split across `workflowKey` and `workflow`; `createdAt` carries what it
called `createdAtMs`; `ApprovalRow.payload` is the `ApprovalTarget.Node`
envelope a client submits back unchanged. A client written against the control
plane reads these rows with no translation table, and no client reconstructs
authority for itself.

One field is deliberately not folded. `RunSummaryRow.status` is the control
plane's own status, taken from the run row rather than from the journal,
because a status written under a fence does not always journal an event of its
own. A verdict folded from events alone can name the run's previous state.

## How a node gets its id

`run-tree` folds agent cell calls, not child runs. A node opens on
`control.agent.cell-call-started` and settles on the matching
`control.agent.cell-call-settled`, and neither record names a node:
[`@smthrs/agent`](/api/agent) `AgentSession` journals `{flowName, input}` on the
start and `{flowName, outcome, message, value}` on the settlement.

So the ordinal the call opened on is its published key, not a fallback. The
first call is `call-1`, the second `call-2`. A settlement is paired with the
oldest open call of the same flow name, which is the only pairing those fields
support, and a settlement that matches no open call is dropped rather than
stealing another call's row.

`node-output` keys its rows the same way and advances its ordinal on exactly
the same events, so the node id a tree view shows is the node id
`node-output` answers for, and the node id [`smthrs output`](/cli/output)
accepts. A fold that skipped an event before advancing its ordinal would shift
the two apart.

A node that never settled stays `running`, which is how a live tree renders
work in flight.

## What is not in a projection

The durable engine's own `flows.engine.*` records are not folded here, and
cannot be. A host keeps the control plane and the engine in two databases with
two journals, and `Control.watch` reads one run's partition of the control
journal alone. What an engine step did reaches a client as the agent call that
made it.

## The folds are pure and total

`GatewayProjection.runSummary`, `runTree`, `approvals`, `nodeOutput`, and
`transcript` are ordinary functions from control facts to rows. They read no
service, and an event kind outside their vocabulary contributes nothing rather
than failing the fold. Wire payloads are JSON, so every field read tolerates
absence: the digest of a malformed journal is a sparse digest, never a throw.

That purity is what makes a delta trustworthy. A subscription recomputes the
selector's rows from accumulated events rather than patching them, and
recomputation is only safe because the same events always fold to the same
rows. The two append-only projections, `run-events` and `transcript`, send
only what one event added instead. See
[Subscriptions and cursors](./subscriptions.md).

## What a projection costs

A projection reads one journal per run, so the read is bounded on purpose:

| Bound                            | Value  | What it caps                                         |
| -------------------------------- | ------ | ---------------------------------------------------- |
| `Projections.maxWorkspaceRuns`   | 500    | runs one workspace projection folds                  |
| `Projections.maxEventsPerRun`    | 10,000 | events one run projection admits                     |
| `Projections.maxProjectionBytes` | 4 MiB  | encoded event history, and encoded projected row set |

`maxWorkspaceRuns` equals `ControlSchema.maxPageSize`, so the control plane can
satisfy the whole gateway allowance in one page when it can. A workspace with
more runs is answered as its first 500. Past either byte or event bound, the
fold fails with `resource_limit` at the first value over the line instead of
retaining the rest of a hostile or corrupt stream.

The approvals inbox is the one workspace projection that filters before it
counts: it asks the control plane for runs whose status is `waiting-approval`,
and admits only runs still in that status with at least one pending gate after
reconciling their journals. Snapshot admission and live refresh use the same
predicate: cancellation removes a run even when its gate remains pending.
A run with no pending gate does not consume the source allowance. An inbox
cannot be exhausted by completed histories.
