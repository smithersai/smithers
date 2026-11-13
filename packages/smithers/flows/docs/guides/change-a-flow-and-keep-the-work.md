---
title: "Change a flow and keep the work"
description: "Build a three-step flow whose finished steps later runs reuse, print its plan before anything runs, then add a step, edit a step, and change the input, and see exactly which steps run each time."
sidebar:
  order: 0
---

A flow you already ran keeps its finished steps. Add a step and only the new
step runs. Edit a step and it runs again, along with any later step whose input
changes as a result. This guide builds a three-step flow, prints its plan
without running it, then changes it four ways.

Reuse across runs is opt-in, per step. A step that opts in declares a key built
from its input and the files it reads and writes, and the program declares the
environment its results depend on. The program below does all three, and
[When a result is reused](#when-a-result-is-reused) has the rules.

## Prerequisites

An additive result-schema migration can explicitly retain an existing action's
cache identity with `Context.make(Action.CacheDeclaration, { success: priorSuccess,
error: priorError })` in its `annotations`. Use this only when the current
decoders accept every prior result with the same meaning, such as adding an
optional receipt field. The current schemas still encode and decode results;
the annotation retains only the declaration's contribution to the key. Without
the annotation, changing either schema remains a cache miss. Keep the original
declaration in the annotation across later compatible extensions.

Node.js 22.19.0 or later; [Installation](../installation.md) has the details.
Create a project:

```bash
mkdir fix && cd fix
npm init -y && npm pkg set type=module
npm install @smthrs/platform-node@next @smthrs/flows@next effect
```

## Write the flow

Create `fix.ts`. It declares three steps: plan a fix, run the tests, and write a
report. The flow calls the first two; you add the third later. Each step's code
is a stand-in that prints a line when it actually runs, so the output shows
which steps ran and which were reused.

```ts
import { Action, Flow, Graph, Interpreter, Plan } from "@smthrs/flows"
import { NodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { resolve } from "node:path"

// A step a later run may reuse declares two things: a key built from its
// input, and the files it reads and writes. These steps touch no files.
const noFiles = { readSet: [], writeSet: [], boundaryMode: "hard" } as const

const MakePlan = Action.make("fix/MakePlan", {
  payload: { issue: Schema.String },
  success: Schema.String,
  idempotencyKey: (input) => JSON.stringify(input),
  fileBoundary: noFiles
})

const RunTests = Action.make("fix/RunTests", {
  payload: { plan: Schema.String, command: Schema.String },
  success: Schema.String,
  idempotencyKey: (input) => JSON.stringify(input),
  fileBoundary: noFiles
})

const WriteReport = Action.make("fix/WriteReport", {
  payload: { result: Schema.String },
  success: Schema.String,
  idempotencyKey: (input) => JSON.stringify(input),
  fileBoundary: noFiles
})

// `then` passes one step's result to the next step.
const then = Plan.Node.bindPlanned

const Fix = Flow.make("fix/Fix", {
  payload: { issue: Schema.String },
  success: Schema.String,
  body: (input) =>
    MakePlan.call(input).pipe(
      then((plan) => RunTests.call({ plan, command: "npm test" }))
    )
})

const input = { issue: process.env.ISSUE ?? "#42" }

// The plan: every step the flow will run, built without running any of them.
const planned = Graph.nodes(Graph.build(Fix, input)).flatMap((node) =>
  node.ast._tag === "ActionCall" ? [node.ast.action] : []
)

if (process.argv.includes("--plan")) {
  for (const step of planned) console.log(`will run  ${step}`)
  console.log(`${planned.length} steps planned. Nothing has run.`)
  process.exit(0)
}

// Stand-ins for real work: each prints a line when it actually runs.
let ran = 0
const work = (step: string, result: string) =>
  Effect.sync(() => {
    ran++
    console.log(`ran       ${step}`)
    return result
  })

const flows = Interpreter.layer(Fix).pipe(
  Layer.provideMerge(MakePlan.toLayer(({ issue }) => work("fix/MakePlan", `plan for ${issue}`))),
  Layer.provideMerge(RunTests.toLayer(({ plan, command }) => work("fix/RunTests", `${command} passed: ${plan}`))),
  Layer.provideMerge(WriteReport.toLayer(({ result }) => work("fix/WriteReport", `report: ${result}`))),
  Layer.provideMerge(Action.layerImplementations),
  // The environment every result depends on. Change an entry and every step runs again.
  Layer.provideMerge(Action.layerCacheEnvironment({ layers: ["node@26", "fix@1"], capabilities: {} }))
)

const workspaceRoot = resolve("workspace")
const host = NodeRuntime.layerHost(
  { filename: `${workspaceRoot}/.flows/engine.db`, workspaceRoot, owner: { hostId: "fix" } },
  flows
)

const result = await Effect.runPromise(Fix.execute(input).pipe(Effect.provide(host), Effect.scoped))
console.log(`result    ${result}`)
console.log(`${ran} of ${planned.length} steps ran`)
```

Three declarations make a step's result reusable by a later run:

- **`idempotencyKey`** turns the step's input into its key. A later run that
  gives the step the same input finds the same key. A string key belongs to
  the step that declares it, so two steps given the same input never share a
  result.
- **`fileBoundary`** lists the files the step reads (`readSet`) and writes
  (`writeSet`). These steps touch no files, so both lists are empty. With
  `boundaryMode: "hard"`, a step that touches a file it did not list is refused.
- **`Action.layerCacheEnvironment`**, once for the whole program, names
  everything outside the steps that can change a result: here the Node major
  version and a version for the program itself, `fix@1`. `capabilities` lists
  the permissions the program grants, and this one grants none.

Leave any of the three out and that step runs on every run. That is the safe
default: a result is reused only when the program has said what it depends on.
`Action.withCache` is not needed here. It narrows how far a result may travel
or how long it stays usable, and a step without it may be reused by any later
run.

The function you pass to `then` runs once, while the plan is built, before any
step runs. Its argument, `plan`, stands for `MakePlan`'s future result, so pass
it into the next step's input rather than reading it.

## See the plan before anything runs

`Graph.build(Fix, input)` builds the flow's plan from the declarations alone,
and `Graph.nodes` lists what it holds. The `ActionCall` nodes are the steps, in
the order they run. With `--plan`, the program prints them and exits before it
opens the database:

```bash
node fix.ts --plan
```

```text
will run  fix/MakePlan
will run  fix/RunTests
2 steps planned. Nothing has run.
```

No step ran and nothing was written: there is no `workspace` directory yet. The
same list is where each run's `2 of 2 steps ran` line gets its total.
[Inspect the plan a body builds](../../flow/docs/guides/inspect-the-plan.md)
reads the rest of the graph: every node, its dependencies, and the edges
between them. [Diff two plans](../../plan/docs/guides/diff-two-plans.md)
compiles two versions of a flow and compares them.

## Run it

```bash
node fix.ts
```

```text
ran       fix/MakePlan
ran       fix/RunTests
result    npm test passed: plan for #42
2 of 2 steps ran
```

Run it again, unchanged:

```text
result    npm test passed: plan for #42
0 of 2 steps ran
```

Each `node fix.ts` is a new run, because `Fix.execute(input)` names no
`executionId`. The new run found both steps' keys already recorded and returned
their results without running them.

## Add a step

Add `WriteReport` to the end of the flow:

```ts
const Fix = Flow.make("fix/Fix", {
  payload: { issue: Schema.String },
  success: Schema.String,
  body: (input) =>
    MakePlan.call(input).pipe(
      then((plan) => RunTests.call({ plan, command: "npm test" })),
      then((result) => WriteReport.call({ result }))
    )
})
```

The plan now has three steps:

```text
will run  fix/MakePlan
will run  fix/RunTests
will run  fix/WriteReport
3 steps planned. Nothing has run.
```

Run it. Only the new step runs:

```text
ran       fix/WriteReport
result    report: npm test passed: plan for #42
1 of 3 steps ran
```

`MakePlan` and `RunTests` got the same input as before, so the run reused their
results, and `WriteReport` received `RunTests`'s recorded result as its input.

## Edit a step in the middle

Change the command the flow gives `RunTests`:

```ts
const Fix = Flow.make("fix/Fix", {
  payload: { issue: Schema.String },
  success: Schema.String,
  body: (input) =>
    MakePlan.call(input).pipe(
      then((plan) => RunTests.call({ plan, command: "npm test -- --coverage" })),
      then((result) => WriteReport.call({ result }))
    )
})
```

```text
ran       fix/RunTests
ran       fix/WriteReport
result    report: npm test -- --coverage passed: plan for #42
2 of 3 steps ran
```

`MakePlan` was reused because its input did not change. `RunTests` ran because
its input did. `WriteReport` ran because its input is `RunTests`'s result, and
that result changed. Had `RunTests` returned the same text as before,
`WriteReport` would have been reused as well: a step runs again only when what
it reads has changed.

Put anything you expect to edit, such as a prompt or a command, in the step's
input, as this flow does with the command. An edit there reruns exactly the
steps it reaches.

## Edit a step's code

The key covers a step's input, not its code. Change what `RunTests`'s code
returns and run again:

```ts
const flows = Interpreter.layer(Fix).pipe(
  Layer.provideMerge(MakePlan.toLayer(({ issue }) => work("fix/MakePlan", `plan for ${issue}`))),
  Layer.provideMerge(
    RunTests.toLayer(({ plan, command }) => work("fix/RunTests", `${command} passed, 0 skipped: ${plan}`))
  ),
  Layer.provideMerge(WriteReport.toLayer(({ result }) => work("fix/WriteReport", `report: ${result}`))),
  Layer.provideMerge(Action.layerImplementations),
  // The environment every result depends on. Change an entry and every step runs again.
  Layer.provideMerge(Action.layerCacheEnvironment({ layers: ["node@26", "fix@1"], capabilities: {} }))
)
```

```text
result    report: npm test -- --coverage passed: plan for #42
0 of 3 steps ran
```

Nothing ran, and the result is still the old text. To tell the engine the code
changed, give the step an `implementationVersion` and change it whenever you
change the code. It goes in two places, the declaration and `toLayer`:

```ts
const RunTests = Action.make("fix/RunTests", {
  payload: { plan: Schema.String, command: Schema.String },
  success: Schema.String,
  idempotencyKey: (input) => JSON.stringify(input),
  fileBoundary: noFiles,
  implementationVersion: "2"
})
```

```ts
const flows = Interpreter.layer(Fix).pipe(
  Layer.provideMerge(MakePlan.toLayer(({ issue }) => work("fix/MakePlan", `plan for ${issue}`))),
  Layer.provideMerge(RunTests.toLayer(
    ({ plan, command }) => work("fix/RunTests", `${command} passed, 0 skipped: ${plan}`),
    { implementationVersion: "2" }
  )),
  Layer.provideMerge(WriteReport.toLayer(({ result }) => work("fix/WriteReport", `report: ${result}`))),
  Layer.provideMerge(Action.layerImplementations),
  // The environment every result depends on. Change an entry and every step runs again.
  Layer.provideMerge(Action.layerCacheEnvironment({ layers: ["node@26", "fix@1"], capabilities: {} }))
)
```

```text
ran       fix/RunTests
ran       fix/WriteReport
result    report: npm test -- --coverage passed, 0 skipped: plan for #42
2 of 3 steps ran
```

If the two values differ, the program stops before any step runs:

```text
@smthrs/flow/ImplementationVersionMismatch: Action "fix/RunTests" requires its declared implementationVersion at registration.
```

## Change the input

```bash
ISSUE="#43" node fix.ts
```

```text
ran       fix/MakePlan
ran       fix/RunTests
ran       fix/WriteReport
result    report: npm test -- --coverage passed, 0 skipped: plan for #43
3 of 3 steps ran
```

The flow's input reaches `MakePlan`, so `MakePlan` ran and returned a new plan,
and each step after it read a changed input.

## When a result is reused

A step's recorded result is reused when the step declares an `idempotencyKey`
and a `fileBoundary`, the program provides `Action.layerCacheEnvironment`, and
the step's key matches a recorded one. The key is made from:

- the string `idempotencyKey` returns, which here is the step's whole input,
  including any earlier step's result it reads;
- the step's name and its declared result schema;
- its `fileBoundary` and its `implementationVersion`;
- every entry of the cache environment.

Anything else runs. In particular, the key does not cover the code inside
`toLayer`: change the code and change its `implementationVersion` with it.

### Same executionId, same result

`Fix.execute(input)` starts a new run every time, and each step is looked up by
its key. Passing an `executionId` names one run instead, as the
[Quickstart](../quickstart.md) does with `"quickstart-1"`. Ask for a run that
already finished and the engine returns that run's recorded result without
reading the flow again, so a step you added or edited since then does not run.

To see it, name the run:

```ts
const result = await Effect.runPromise(
  Fix.execute(input, { executionId: "fix-1" }).pipe(Effect.provide(host), Effect.scoped)
)
```

Run it, then change the command to `"npm run test:ci"` and run it again. Both
runs print the same thing:

```text
result    report: npm test -- --coverage passed, 0 skipped: plan for #42
0 of 3 steps ran
```

The first run of `fix-1` was a new run that reused every step by key. The
second asked for `fix-1`, which had finished, so it returned the recorded
result and ignored the new command. Remove the `executionId` and the edit runs:

```text
ran       fix/RunTests
ran       fix/WriteReport
result    report: npm run test:ci passed, 0 skipped: plan for #42
2 of 3 steps ran
```

An `executionId` that already finished cannot take a different input either.
`ISSUE="#43" node fix.ts` under `fix-1` stops with:

```text
@smthrs/engine/ExecutionIdentityConflict: execution fix-1 was started with a different input; choose a new executionId to run this input
```

Name an `executionId` when you want one run's recorded result back. After you
change the flow, leave it out or use a new one.

## Next steps

- [Quickstart](../quickstart.md): one flow end to end, including the permission
  its step needs to read a file.
- [Stand up a durable Node runtime](./stand-up-a-node-runtime.md): what
  `NodeRuntime.layerHost` builds, and the other entry points.
- [Diff two plans](../../plan/docs/guides/diff-two-plans.md): compare the
  plans of two versions of a flow before running either.
- [API reference](../api.md): every export of `@smthrs/flows`.
