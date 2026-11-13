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

## One round per plan

A flow declares its graph before it runs. `Recursion.recurse` expands a
recursive tree at plan time, which requires the tree to be a literal value the
author already holds. A delegated plan is not: a model writes it while the run
is in flight.

So a trellis spends one trampoline round per authored plan. A round ends by
handing the plan to the next round with the `To` outcome `@smthrs/flow`
defines; the next round receives it as payload, reads it as data while its
graph is built, and declares exactly the leaf calls it names. Each round is its
own journal segment, so a crash resumes at a round boundary, never in the
middle of a tree no graph described. The envelope's `fuel` bounds the whole
lineage before anything runs.

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
refuse it. Both decoding and runtime validation reject excess properties on a
plan node, including nested nodes.

`execute` copies plans before running them and omits `seat` when it is absent.
Leaf payloads also omit an absent seat.

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

An envelope that is not made of positive safe integers makes
`Trellis.make` throw `TrellisError` with code `invalid_envelope`.

`Trellis.leaves(plan)` lists the leaves in plan order with their paths. The
count is the plan's cost in fuel, and the paths are the stable keys a caller
uses to index leaf outputs.

### Running

```ts
const delegate = Trellis.make({
  envelope: { fuel: 6, depth: 3, fanout: 3 },
  author: Planner, // called with the caller's input; answers a Trellis.Plan
  leaf: Worker, // called with { goal, seat?, path } for each agent the plan names
  continue: FollowUp // optional: called with { plan, result, round, remaining }
})

const result = yield * delegate.execute({ input: { prompt: "ship the release notes" } }, { executionId })
```

The first round calls `author` and hands its plan to the next round. A plan
round validates the plan against the envelope and the fuel left, runs exactly
the leaves it names, and then, when `continue` is supplied, asks it for the
next plan. The trellis settles with `{ rounds, remaining }`: every round's
plan and result, and the fuel left over.

A continuation is a request for another round. Returning `null` ends the
trellis, and so does returning a plan that names no work within the envelope
depth. Deeper continuations fail with `depth_exceeded`, including trees made
entirely of empty containers. Every other round costs at least one leaf, so a
trellis always ends within `fuel` plan rounds.

A refused plan fails its round with a `TrellisError`, and none of its leaves
runs. A leaf that fails fails the round with its own error.

`Trellis.execute(plan, { leaf, concurrency })` checks the plan's shape and
runs it in process. It snapshots the plan and options at the call; a malformed
plan fails through the Effect error channel with its first shape refusal,
before any leaf factory runs. Unreadable, cyclic, or excessively nested plans
also fail with `invalid_plan`. Apply envelope bounds with `Trellis.validate`
before executing. One shared semaphore bounds both
leaf factory calls and their returned Effects across all nested containers.
`DelegationChain.run` uses it.

## DelegationChain

`DelegationChain` is the fixed chain: refine, plan, derisk, execute, review,
settle. It adds no new machinery. `ReviewLoop` runs the derisk rounds,
`Trellis` admits and executes the derisked plan, and `Escalation` walks the
tier ladder weakest first. A tier retries through the `retryPolicy` of the
actions it calls, so the engine spends those attempts durably; the chain
escalates only once a tier has failed or its output was rejected. The module
owns the order those parts run in and the bounds they run under.

`make` declares what `run` executes. Every tier call it declares carries the
same `Work` a tier is run with, every leaf review names the tier that produced
the output, and settle carries the keys `run` settles with. The derisk loop is
the one exception, because `ReviewLoop` owns those payloads: it reviews with the
produced plan and revises with `{ output, review, round }`, while `run` names
the goal and the round in both.

### Bounds

Every chain declares `tierOrder` (weakest tier first), `maxDepth`, and
`maxDeriskRounds`. `execute` supplies one flow per tier named
in `tierOrder`. A bound that is not a positive safe integer, an empty
`tierOrder`, or a tier with no flow is refused with `DelegationError` carrying
code `invalid_bounds` or `missing_tier`.

The chain declares no attempt budget. Give the action a tier calls a
`retryPolicy` (`maxAttempts`, the backoff ladder, `nonRetryable` tags): the
engine retries it inside the one declared tier call, records each attempt, and
the ladder admits the next tier only after that policy is spent.

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
4. Each leaf climbs the tier ladder weakest first. Each tier is called once;
   a tier that fails, or whose result `review` rejects, admits the next. The runtime
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

`DelegationChain.make(options)` declares the chain in two durable rounds. The
first round refines the input into a goal and runs the derisk loop, unrolled to
`maxDeriskRounds`, then hands the goal and the loop's outcome to the execution
round with `Flow.to`. The execution round reads the derisked plan as data,
validates it against the envelope `{ fuel, depth, fanout }`, all `maxDepth`,
and declares one tier ladder per leaf the plan names, with the leaf's real goal
and path. Review and settle follow, and settle receives every leaf output in
plan order and whether the derisk loop ran out of rounds. A crash resumes at
the round boundary.

A declared ladder escalates when a tier's call fails, after the engine has
spent the `retryPolicy` of the tier's actions, or when the review rejects its
output. A ladder no tier settles fails `DelegationError` with code
`leaf_failed` at the leaf's path, and no later stage runs. A plan outside the
envelope fails with the `TrellisError` that names the bound, and no leaf runs.

`DelegationChain.bound(bounds)` is the most flow calls the two rounds make:

```text
4 + 2 * maxDeriskRounds + maxDepth * 2 * tierOrder.length
```

Four calls are fixed (refine, the derisk loop, the chain review, settle). Each
of the at most `maxDepth` leaves contributes one execute plus one review call
per tier it climbs. A supplied flow whose own body calls other flows adds those
on top; an action's retries are attempts of one call, not more calls.

The ladder is declared here rather than with `Escalation.make` because that
constructor asks one shared `accept` flow about every rung, and the review `run`
performs names the tier that produced the output. The topology is the same: one
call per rung, one review per rung, weakest first.

## The durable recipe

`Trellis.make` is this recipe packaged. [Delegation trellis](/docs/examples/33-delegation-trellis/) writes it out by hand, for a
caller that wants its own payloads:

1. The first round calls the author step and hands the result off with
   `RunPlan.to({ goal, plan })`. Its body never looks inside the plan, because at
   build time the author's result is still a placeholder.
2. The second round receives the plan as payload, so `Trellis.validate` and
   `Trellis.leaves` run over real data while the graph is built. The leaves
   become one `Node.all` join of durable steps.

## Applying a memory policy

`@smthrs/memory` wraps a trellis so every generated leaf inherits one memory
namespace, recall budget, and retention rule. See
[`MemoryTrellis`](/api/memory#memorytrellis).
