---
title: "Delegate to child agents"
description: "Run attached children through ordinary ctx.call, and detached children through agent/spawn, agent/send, and agent/await over the durable EngineChildren port."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/subagents.md"
---

A cell delegates by finding a flow in `ctx.flows` and calling it.

## Attached markdown children need a host runner

A discovered markdown flow is callable through `ctx.call("review", { args })`
when the host supplies `promptRunner`. Set it on `AgentSession.Options` or
`AgentAction.Host`; both forward it to `Agent.Options.promptRunner`.

The registry renders the markdown body against `{ args: string }`. The runner
receives `{ call, text }` and returns an
`Effect<Cell.CallResult, HarnessError>` with no unmet service requirements.
Close over or provide the child's seat resolver, model, registry, sandbox,
budget and quota policy, and durable runtime when constructing the runner.
A runner built from `Agent.run` also needs `Steering.Source` and must execute
inside a running flow with `FlowRuntime` and `FlowInstance` in context.
The adapters do not choose the child's seat or install these dependencies for
it. Use the call identity for durable child execution identity and preserve the
parent's capability restrictions.

The engine port records the attached call inside its durable cell boundary.
The runner supplies the child execution and returns its answer as a successful
`Cell.CallResult`, or propagates a `HarnessError` when the child must fail or
park the run. Without a runner, markdown calls return the catchable
`unimplemented` refusal. Module-backed flows use executable bindings or host
implementations instead.

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

Keep returned ids opaque. `await` and `send` accept already-persisted legacy
ids. To re-drive parents whose children used `${parentExecutionId}/child/${label}`,
compose their port with `legacyChildIds: true`. This mode starts only existing
rows and refuses new legacy children. Use the default port for new parents.
Legacy rows retain their original identities, including any pre-existing label
ambiguity; they are not automatically migrated.

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
