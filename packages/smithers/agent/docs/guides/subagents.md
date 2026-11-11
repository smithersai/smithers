---
title: "Delegate to child agents"
description: "Run attached children through ordinary ctx.call, and detached children through agent/spawn, agent/send, and agent/await over the durable EngineChildren port."
sidebar:
  order: 6
---

A cell delegates by finding a flow in `ctx.flows` and calling it.

## Attached markdown children

A cell runs a discovered markdown flow as a child agent with one call:

```ts
const answer = await ctx.call("worker", { args: "List the files under src/ that import the parser." })
if (typeof answer !== "string") console.log(answer.error.code, answer.error.message)
```

The value is the child's `ctx.done` text. The native CLI host (`smthrs plan`,
`approve`, and `run`) runs markdown children for every run it starts. Any
other host opts in, as the next section shows.

### Write the child flow

A child is a markdown flow in `.smithers/flows/<name>/flow.mdx`, beside the
flow that calls it:

```md
---
description: Does one sub-task it is handed and answers with ctx.done.
---

Do the sub-task in the arguments, then call ctx.done with what you found.
```

- `description` is required; the caller reads it in `ctx.flows`.
- Leave out `model:` to run on the caller's seat, the same model and route.
  Name a seat to run on that one instead.
- Leave out `effort:` to run at the caller's reasoning effort.
- Leave out `capabilities:` to give the child the caller's whole authority.
  A flow that names none claims every capability, and only a caller that
  holds every capability may call it. A flow that names a list runs with that
  list, and the call is refused with `capability_refused` unless the caller
  holds all of it.

The child's prompt is the flow's body followed by `args`.

### What a child gets

A child is the same agent loop as its caller, run inside the caller's call:

- The caller's host flows: file flows, `bash`, `jev`, and the rest. On a host
  sealed to a container (`SMITHERS_BASH_CONTAINER`), the child's flows reach
  that one container and nothing on the host.
- No `wait` and no `ask`, and no approval channel. A quota or budget refusal
  fails the child rather than parking. A child never parks its caller.
- No markdown flow. Children nest one level deep.
- No opening memory, no memory writes, and no steering. Operator messages
  reach the caller at its next frame.
- The caller's budget and time. The child spends the run's budget, and it
  runs inside the caller's call, so it cannot outlive the caller's frame. A
  long child needs a call that names its time:
  `ctx.call("worker", { args, timeoutSeconds: 900 })`, held to what the frame
  has left (`Sandbox.callLimit`).
- The caller's frame budget (`maxFrames`) and sandbox limits.

A run is never offered itself as a child. A project whose only markdown flow
is the run's own flow shows the same `ctx.flows`, and sends the same model
request bytes, as a host that runs no children.

### Failures

A child that fails, runs out of frames without `ctx.done`, or names a seat the
host cannot resolve resolves the call as a failure the cell reads:

```ts
{ ok: false, error: { code: "flow_failed", message: "The child run of worker failed: ...", hint: "..." } }
```

The caller's run goes on.

### Durability

The child runs inside the caller's durable call boundary, keyed like any other
call. A replay of the caller is served the call's recorded answer and runs no
model call for the child. A child cut off by a crash runs again from its own
sealed model steps, which are keyed under the child's session,
`<caller session>/child/<callId>`.

### Read a child's trail

Each child event is journaled in the run's control journal (`.flows/control.db`)
under `control.child.*` in place of `control.agent.*`.
`control.child.model-settled` carries the child's `usage`, as
`control.agent.model-settled` does for the caller. Every child record carries
`child: { callId, flow, scope }`:

- `callId` is the caller's call, the value its `control.agent.cell-call-started`
  and `control.agent.cell-call-settled` records carry. File the child's frames
  under that call.
- `scope` is the child's session. The child's `model-requested` and
  `model-settled` records carry the same value as their own `scope`.

Readers of `control.agent.*`, such as the caller's frame count and resume
validation, never see a child's records.

### Run children on another host

`AgentSession.Options.markdownChildren` and `AgentAction.Host.markdownChildren`
turn markdown children on for a host. Each forwards to
`Agent.Options.children`, which takes the child's flow sources, the
`SeatResolver` for a declared `model:`, the run's own flow name, and an
`observe` callback for every child event. `AgentSession` journals child events
into the run's trail; `AgentAction` journals them on the lossy channel when
its composition has a journal.

A host can instead supply its own `promptRunner` on either adapter, which wins
over `markdownChildren`. The registry renders the markdown body against
`{ args: string }`, and the runner receives `{ call, descriptor, text }` and
returns an `Effect<Cell.CallResult, HarnessError>` with no unmet service
requirements. Without `promptRunner` or `markdownChildren`, a host shows no
markdown flow and a call to one is refused with `unimplemented`. Module-backed
flows use executable bindings or host implementations instead.

## Detached children need the lifecycle flows

Spawn now, collect later needs lifecycle operations, and those are ordinary
flow names: `agent/spawn`, `agent/send`, and `agent/await`. Bind them over a
`Children` port:

```ts
import { ChildFlows, EngineChildren } from "@smthrs/agent"

// In the composition, beside the engine:
const childrenLayer = EngineChildren.layer({ flows: [ReviewFlow, ResearchFlow] })

// Inside a flow body, where the Children service is in context:
const children = yield* ChildFlows.Children

const run = agent.run({
  // session, seat, prompt, registry ...
  flows: [ChildFlows.source(children)]
})
```

`EngineChildren.layer({ flows })` is the durable implementation over the host's
engine, and its `flows` option is the authority behind
`ChildError { code: "not_found" }`: a name that is not listed names nothing
this host can start. Registering the flow with the runtime is separate and
still required; the list is what the child lifecycle is allowed to reach, not
what the engine knows how to run.

A host with no durable run store binds nothing and the port refuses honestly:
`ChildFlows.makeNoop()` fails every operation with
`ChildError { code: "unsupported" }`, which the cell can see and route around.

## spawn

`agent/spawn` starts the named flow as a run of its own: a separate row, a
separate claim, a separate journal, linked to the caller through the engine's
parent-edge table. It is spawned with the result discarded, which records
`onParentExit: "detach"` on the child, so the child outlives the run that
started it instead of being cancelled with it.

The child's execution id is derived, not minted:
`child-v2:<parent length>:<parent><label length>:<label>`, with lengths in
JavaScript UTF-16 code units. The label defaults to the flow name. Both
components are length-delimited, so a label containing `/child/` cannot alias
a nested child. A parent that is re-driven, by a resume, a reclaim, or a replayed cell,
spawns the same child rather than a second one, because the engine's create is
idempotent on the execution id. The label is therefore the child's identity
within its parent: two concurrent children of one flow need two labels.

Keep returned ids opaque.

`spawn` answers once the child's run row exists, within `startTimeout`
(default 30 seconds). Until admission succeeds, failure, a store defect, or
cancellation interrupts and joins the startup fiber before returning. After
admission the child continues independently. A start that produces no row is
`ChildError { code: "failed" }`, never `not_found`: the flow is declared, so
the refusal is the runtime's, and a cell reading `not_found` would wrongly
decide never to ask again.

## await

`agent/await` reads the child's settled result out of the run store, so it
works from a different engine, a different process, and a later incarnation
than the one that spawned the child. A string child answers with its own text;
any other value is answered as JSON.

`await` waits by re-reading the child's run row on an interval (`pollInterval`,
default 250 ms) rather than suspending the run, so a cell that awaits a long
child holds its round open. That is a bounded, honest cost of the port's shape.
The distinct endings:

- A cancelled child is `ChildError { code: "failed" }`.
- A failed child is `failed` with the rendered cause, bounded to 2,048
  characters.
- A child whose round handed its lineage to a new execution id is `failed`:
  that id holds no value, and an await that kept polling it would wait forever.
- An unknown child id is `not_found`.
- A child still running after `timeoutSeconds` (1 to 3600; the port's
  `awaitTimeout`, 10 minutes, when omitted) is `still_running`. Await it again
  to keep waiting.
- A run store that cannot answer is `failed`, never `not_found`.

## send

`agent/send` steers the child through `Control.steer`, which admits a durable
`human-steer` message the child drains at its next turn boundary. Two
properties make it safe to re-drive:

- The message is named with the calling step's canonical key, an ordinal
  counted inside the enclosing dispatch. A re-driven round derives the same key
  and the control plane admits the message once, while the next send in the
  same scope gets the next ordinal and is delivered as its own message.
- The timestamp is read inside a sealed step, so a re-drive submits the same
  bytes and the control plane recognizes its own earlier admission.

`send` answers from the receipt, not from optimism. `Accepted` admitted the
message and `AlreadyApplied` recognized the one this same step submitted
before, so both report `delivered: true`. Every other receipt fails the call,
because nothing was admitted: a `Conflict` says the key already carries
different material, and a `Terminal` says the child ended before the message
could reach it.

## Errors the cell can route around

`ChildError` is separate from `HarnessError` on purpose: an unsupported
operation, an unknown flow or child, and a child that failed are data the cell
may catch, while a `HarnessError` is a park or an abort the cell must never
swallow. A host that needs to park a lifecycle operation fails with the latter,
or gates it in `Agent.Options.authorize`.
