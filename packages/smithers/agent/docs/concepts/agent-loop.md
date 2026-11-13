---
title: "The agent loop"
description: "How the production cell loop sits on the durable engine: cells, frames, the event stream, and when AgentSession versus AgentAction runs it."
sidebar:
  order: 1
---

`Agent` is one service with one method, and understanding it is understanding
three things: what a cell is, what a run returns, and why there are two
adapters instead of two loops.

## Cells and frames

A run is a conversation between the model and a QuickJS sandbox, one frame at a
time. Each frame the model emits a **cell**: a JavaScript program that runs in
the sandbox's realm. The realm outlives the frame, so names bound by frame 3
are still bound in frame 9, and a cell reads what earlier cells built instead
of re-deriving it.

A cell's only authority is `ctx.call(flowName, input)`. There is no `ctx.fs`,
no `ctx.shell`, no fetch. Every capability a cell reaches is an ordinary flow
settling through a durable boundary: keyed, journaled, and permission-gated
like any other activity. That is what makes a crash mid-cell survivable: the
re-executed cell replays the boundaries that already settled and reaches the
unsettled one deterministically.

The cell contract, the controller, and the sandbox belong to
[`@smthrs/harness`](/api/harness). This package composes them; it does not
reimplement them.

## What a run returns

`Agent.run` returns the framework-neutral `Stream<AgentEvent>` the controller
emits. There is no callback, no event emitter, and no host-shaped result type.
A caller renders the stream, journals it, or ignores it:

- `AgentSession` consumes it and projects every event onto the run's journal
  trail.
- `AgentAction` buffers it and answers with the decoded value of the final
  `complete` transition, optionally handing each event to an `EventSink` on the
  way past.
- A direct caller drains it for its own purposes.

The stream's requirements tell the same story: `FlowRuntime` and `FlowInstance`
(a run must be started inside a running flow body, because the engine port is
per-execution), plus `Sandbox`, `Steering.Source`, `Budget.Budget`,
`QuotaPolicy.QuotaClassifier`, and `Evaluator.Evaluator`, which the host supplies.
`Agent.layerDefaults` provides browser-safe defaults for `Sandbox` and
`Steering.Source`. The host supplies the budget, quota policy, and evaluator.
Nothing in the composition imports a Node built-in, so the same composition
runs in Node and in a browser.

## One catalog, shown and enforced

The registry the model is shown is the registry the boundary resolves against.
The catalog is composed from the registry's visible, model-invocable flows plus
the run's declared `flows`, with plugin `cellFlows` handlers after them, and the
declaration digest a cell was written against is the one checked when the call
arrives. Duplicate names fail composition rather than dispatching one
descriptor to another implementation.

## One loop, two adapters

Everything about how a frame is built, sealed, and replayed lives in `Agent`.
The two adapters decide what a run _is_:

- **`AgentSession`**: a run is a whole control-plane launch. The agent is the
  flow: a markdown prompt body, a declared seat, an operator steering and
  approving it, its events journaled as the run's trail. Choose it when the
  agent is the unit of work an operator manages.
- **`AgentAction`**: a run is one typed step inside a larger flow. The same
  loop, bounded by a declared output schema, replayed like any other action.
  Choose it when the model is one step among other steps.

Neither adapter reimplements the loop, and a future agent that drives a foreign
CLI is another implementation of `Agent.Service`, not a second loop beside this
one. The cell path is the only loop this package has: there is no
provider-tool-call path beside it.

For the durability machinery underneath the loop, see
[The engine port](./engine-port.md). For the policies that keep a run alive,
see [The three policies](./policies.md).
