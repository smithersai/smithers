---
title: "Delegation"
description: "Trellis and DelegationChain: how @smthrs/patterns admits, bounds, and executes a plan a model wrote, and what a refusal tells the plan's author."
---

A model can write a better plan for a task than you can write in advance. It
can also write one that costs a thousand calls. The two patterns on this page
are how you take the first without the second.

`Trellis` runs a plan a model authored, inside an envelope the plan cannot
widen. `DelegationChain` is the fixed six-stage chain built from `Trellis` and
the other patterns here: refine, plan, derisk, execute, review, settle. Both
compose [`@smthrs/flow`](/api/flow) and [`@smthrs/plan`](/api/plan), and import
no Node built-ins.

## Why a plan needs two halves

A flow declares its graph before it runs. `Recursion.recurse` expands a
recursive tree at plan time, which requires the tree to be a literal value the
author already holds. A delegated plan is not: a model writes it while the run
is in flight.

Each of these modules therefore has two halves, and they answer different
questions:

| Half   | Question it answers                         | Value                                             |
| ------ | ------------------------------------------- | ------------------------------------------------- |
| `make` | What is the most work this can possibly do? | a `Flow` whose graph is the conservative topology |
| `run`  | What did the model actually ask for?        | an `Effect` executing the authored plan           |

`make` is what a host reads to budget, place, and admit the work in advance.
`run` is what executes. They agree by construction: `make` declares one leaf
call per unit of fuel, and `run` refuses any plan that costs more fuel than
remains.

Durability follows the same split. A model-authored plan is discovered inside a
round, so a durable host spends one trampoline round per authored plan: the
round plans a bounded graph, journals it, and hands off to the next round with
the `To` outcome `@smthrs/flow` defines. A crash resumes at a round boundary,
never in the middle of a tree no graph described.

## Trellis

`Trellis.Plan` is the closed grammar a model may answer in. A plan node is
exactly one of:

```ts
{ agent: { goal: string, seat?: string } }
{ sequence: [ Plan, ...Plan ] }
{ parallel: [ Plan, ...Plan ] }
```

A container holds at least one member. An empty one names no work and costs no
fuel, so a round built from it makes no progress; the type and the codec both
refuse it.

Declare `Trellis.Plan` as the output schema of the author flow so the model is
shown that grammar rather than asked for prose.

### Envelope and validation

`Trellis.Envelope` is `Recursion.Envelope`: `fuel` (total leaf calls), `depth`
(nesting levels), and `fanout` (members in one container).

`Trellis.validate(plan, envelope)` returns every reason a value was refused, as
`TrellisError` values carrying a `code` and the `path` the fault was found at
(`root.parallel[1].sequence[0]`). An accepted plan returns an empty array. The
codes are `invalid_envelope`, `invalid_plan`, `depth_exceeded`,
`fanout_exceeded`, and `fuel_exhausted`.

An empty `sequence` or `parallel` is refused as `invalid_plan` at the container's
own path.

Fuel is charged per leaf and checked for the plan as a whole, so a plan that
overspends is refused before any of its leaves runs. `Trellis` owns
`TrellisError` rather than reusing `PatternError` because every rejection
carries a path, and the path is what an author needs to repair the plan.

### Compiling and declaring

`Trellis.compile(plan, { leaf })` turns a validated plan into one node: an
`agent` becomes a call to `leaf`, a `sequence` becomes an `andThen` chain
collecting member results in order, and a `parallel` becomes a `Node.all` join
returned in plan order.

`Trellis.make({ author, leaf, envelope })` declares the conservative topology:
one call to `author`, then `envelope.fuel` calls to `leaf`. The leaf slots are
sequenced because a declaration cannot know how the plan will fan out. Each slot
is declared with the `Leaf` shape `run` and `execute` hand a leaf flow, with the
authored plan standing in for the goal nothing knows yet and the path naming the
slot (`slot-0`). An envelope that is not made of positive safe integers throws
`TrellisError` with code `invalid_envelope`.

`Trellis.leaves(plan)` lists the leaves in plan order with their paths. The
count is the plan's cost in fuel, and the paths are the stable keys a caller
uses to index leaf outputs.

### Running

```ts
const result = yield * Trellis.run("ship the release notes", {
  envelope: { fuel: 6, depth: 3, fanout: 3 },
  author: ({ prompt, remaining }) => planner(prompt, remaining),
  leaf: ({ goal, seat, path }) => worker(goal, seat, path),
  continue: ({ result, remaining }) => (remaining > 0 ? followUp(result) : Effect.succeed(undefined))
})
```

`run` authors a plan, validates it, executes it, and re-authors while
`continue` returns another plan and fuel remains. It returns every round it
executed and the fuel left over.

A continuation is a request for another round. Returning nothing ends the
trampoline, and so does returning a plan that names no work within the envelope
depth. Deeper continuations fail with `depth_exceeded`, including trees made
entirely of empty containers. Every other round costs at least one leaf, so
`run` always terminates.

Concurrency is bounded by one semaphore shared by the whole plan, defaulting to
`envelope.fanout`. Sequence members run in order; parallel members start
together and are admitted by that semaphore, so the bound holds across the plan
rather than per container.

`Trellis.execute(plan, { leaf, concurrency })` is that executor on its own, for
a caller that already holds a validated plan.

## DelegationChain

`DelegationChain` is the fixed chain: refine, plan, derisk, execute, review,
settle. It adds no new machinery. `ReviewLoop` runs the derisk rounds,
`Trellis` admits and executes the derisked plan, `Escalation` walks the tier
ladder weakest first, and `WithRetry` spends the per-tier attempts. The module
owns the order those parts run in and the bounds they run under.

`make` declares what `run` executes. Every tier call it declares carries the
same `Work` a tier is run with, every leaf review names the tier that produced
the output, and settle carries the keys `run` settles with. The derisk loop is
the one exception, because `ReviewLoop` owns those payloads: it reviews with the
produced plan and revises with `{ output, review, round }`, while `run` names
the goal and the round in both.

### Bounds

Every chain declares `tierOrder` (weakest tier first), `maxDepth`,
`maxDeriskRounds`, and `maxAttempts`. `execute` supplies one flow per tier named
in `tierOrder`. A bound that is not a positive safe integer, an empty
`tierOrder`, or a tier with no flow is refused with `DelegationError` carrying
code `invalid_bounds` or `missing_tier`.

Two optional bounds shape the attempts a tier spends. `backoff` is the
`WithRetry.Backoff` ladder waited between one tier's attempts; the default is
immediate retry, so without it a tier spends `maxAttempts` back to back.
`nonRetryable` lists error `_tag` values that end a tier at their first
occurrence, whatever `maxAttempts` allows; the ladder still admits the next
tier. The default retries every failure. A backoff whose `initialMs` is not
positive, whose `factor` is below 1, or whose `maxMs` is below `initialMs` is
refused `invalid_bounds` before any callback runs. `make` declares the same
policy it spends: the retry decorator around each slot's tier ladder is named
`withRetry(delegationTiers(...), attempts=N, backoff=..., nonRetryable=...)`.

`maxDepth` is the whole plan envelope, not the nesting bound alone: a derisked
plan may hold at most `maxDepth` leaves, nest `maxDepth` levels, and put
`maxDepth` members in one container. A plan of four leaves under `maxDepth: 3`
is refused `fuel_exhausted`, and a container of four members under the same
bound is refused `fanout_exceeded`. Raise `maxDepth` to widen all three at once.

### Running

`DelegationChain.run(prompt, options)`:

1. `refine` turns the prompt into a goal.
2. `plan` proposes a `Trellis.Plan`, and `derisk` reviews it. The loop stops at
   the first approved round and gives up after `maxDeriskRounds`, in which case
   `settle` receives `deriskExhausted: true`.
3. The derisked plan is validated against the envelope `{ fuel: maxDepth, depth:
   maxDepth, fanout: maxDepth }`.
4. Each leaf climbs the tier ladder weakest first. A tier spends `maxAttempts`
   retries, waiting the declared `backoff` between them and stopping at the
   first `nonRetryable` tag, before the next tier is admitted, and a tier whose
   result `review` rejects escalates exactly the way a tier that failed does. The runtime
   consumes `Escalation.run`'s `Reached` and `Exhausted` results directly and
   branches on their `exhausted` field: only a reached attempt contributes its
   output, and exhaustion becomes `leaf_failed` before the leaf can reach
   settlement.
5. `review` sees the assembled leaf outputs, then `settle` receives the prompt,
   goal, plan, leaf outputs in plan order, the review, and whether derisk was
   exhausted.

A leaf no tier settles fails `DelegationError` with code `leaf_failed` naming
its plan path, and no later stage runs. A `budget` is threaded into every leaf
input; the chain carries it, and a host that implements a budget capability is
what enforces it.

`DelegationChain.accepted(value)` is the acceptance vocabulary both house
patterns use: `true`, `"approved"`, `{ approved: true }`, or
`{ accepted: true }`.

### Declaring

`DelegationChain.make(options)` declares the conservative chain: the derisk
loop unrolled to `maxDeriskRounds`, then `maxDepth` tier ladders, then review
and settle. `DelegationChain.bound(bounds)` is the flow-call count that
declaration contains:

```text
4 + 2 * maxDeriskRounds + maxDepth * (2 + maxAttempts * (1 + 2 * tierOrder.length))
```

Four calls are fixed (refine, the derisk loop, the chain review, settle). Each
depth slot contributes a retry decorator and a retry declaration, and each of
the `maxAttempts` attempts that declaration makes contributes a tier ladder and
one execute plus one review call per tier. A supplied flow whose own body
calls other flows adds those on top.

Every declared call carries the payload `run` sends. Two values a declaration
cannot know stand in for themselves: the authored plan stands in for the leaf
goals, and `deriskExhausted` is declared `false`, the answer `run` gives when
the derisk loop approves.

The ladder is declared here rather than with `Escalation.make` because that
constructor asks one shared `accept` flow about every rung, and the review `run`
performs names the tier that produced the output. The topology is the same: one
call per rung, one review per rung, weakest first.

## The durable recipe

`Trellis.run` is the in-process executor. A durable host spends one trampoline
round per authored plan instead, because a flow body is built before it runs and
can only read values it already holds. The plan has to arrive as a payload.

[Delegation trellis](/docs/examples/33-delegation-trellis/) is that recipe end
to end:

1. The first round calls the author step and hands the result off with
   `RunPlan.to({ goal, plan })`. Its body never looks inside the plan, because at
   build time the author's result is still a placeholder.
2. The second round receives the plan as payload, so `Trellis.validate` and
   `Trellis.leaves` run over real data while the graph is built. The leaves
   become one `Node.all` join of durable steps.

A refused plan settles the round with the code and path that name the fault, and
no leaf step is dispatched. Each round is its own journal segment, so a crash
resumes at a round boundary.

## Applying a memory policy

`@smthrs/memory` wraps a trellis so every generated leaf inherits one memory
namespace, recall budget, and retention rule. See
[`MemoryTrellis`](/api/memory#memorytrellis).
