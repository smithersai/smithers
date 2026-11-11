---
title: "Certify an engine"
description: "Run the mandatory conformance suite against an engine: implement the EngineSubject port, register the nine pins, narrow the list for a partial subject, and add the restart and hard-kill boundaries."
sidebar:
  order: 5
---

Certifying an engine means running `Conformance.coreSuite()` against an
implementation of `EngineSubject`. The suite is nine black-box pins covering
identity, interruption, replay, and race, and it is the whole conformance
vocabulary.

## Register the suite

```ts
import { Conformance, EngineSubject, FlowEngineLike } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

const subject = FlowEngineLike.layerOver(runtimeLayer)

describe("engine conformance", () => {
  for (const conformanceCase of Conformance.coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.flatMap(EngineSubject.EngineSubject, conformanceCase.run).pipe(
        Effect.provide(subject)
      ))
  }
})
```

`it.scoped` and `it.effect` supply the `TestClock` the race and interrupt pins
advance. `.live` does not, and a pin registered there hangs.

The subject is provided inside the body, so every case builds its own engine.

## Bind a runtime

`FlowEngineLike` adapts the real engine from [`@smthrs/engine`](/api/engine) to
the conformance port, and it reads the runtime out of the ambient service
rather than naming an implementation:

| Binding                        | What it certifies                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `FlowEngineLike.layerMemory`   | The in-memory `FlowRuntime` that ships in `@smthrs/engine`. Zero configuration.        |
| `FlowEngineLike.layerOver(rt)` | Any `Layer<FlowRuntime>`, including the durable one.                                   |
| `FlowEngineLike.layer()`       | The subject alone, for a composition that already provides `FlowRuntime` and `Crypto`. |

The durable runtime is `EngineStore.layer({ owner, journalSource })` from
[`@smthrs/engine-store`](/api/engine-store). `@smthrs/testing` does not depend
on that package, so you install it and pass the layer yourself. Supplying the
layer is the whole connection: the case list does not change.

`layerMemory` keeps every execution, action, and journal entry in process
memory, so it certifies semantics and not durability. "Replay" under it means
the runtime replaying a recorded result inside one process.

## Or implement the port yourself

`EngineSubject` is five methods. `EngineSubject.layer` provides an
implementation, and `EngineSubject.makeNoop` builds one that fails every
operation as unavailable, so a partial subject can be assembled by overriding
what it does support:

```ts
import { EngineSubject } from "@smthrs/testing"

const partial = EngineSubject.layerNoop({
  name: "read-only-subject",
  result: (executionId) => readResult(executionId),
  journal: (executionId) => readJournal(executionId)
})
```

`MemoryEngine` is the worked reference. It holds its durable state in an
externally owned `EngineStore`, so a fresh engine built over the same store
replays completed journal entries and continues at the first unfinished step:

```ts
import { Conformance, MemoryEngine } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

describe("MemoryEngine conformance", () => {
  for (const conformanceCase of Conformance.coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.gen(function*() {
        const store = yield* MemoryEngine.makeStore()
        const engine = yield* MemoryEngine.make(store)
        yield* conformanceCase.run(engine)
      }))
  }
})
```

## Narrow the suite for a partial subject

`coreSuite({ filter })` returns a frozen subset. Filter on the case name, whose
prefix is the family:

```ts
const replayOnly = Conformance.coreSuite({
  filter: (conformanceCase) => conformanceCase.name.startsWith("replay/")
})
```

The nine names are `identity/distinct-executions`, `identity/idempotency-key`,
`identity/digest-key-stability`, `interrupt/fiber-abort`,
`replay/completed-prefix`, `replay/suspended-frontier`,
`race/loser-interrupted`, `race/recorded-winner-replay`, and
`race/recorded-loser-interruption`.

Narrowing is a statement about the subject, not a way to make a red go green. A
pin that runs must either assert behavior or fail with `conformance_skipped`.

## Certify the restart boundaries

`RestartableEngine` holds one persistent store and swaps the live engine over
it, which is how a suite reaches the state a lease-based reclaim recovers from:

```ts
import { Conformance, EngineSubject, RestartableEngine } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

const restartable = Conformance.coreSuite({
  filter: (conformanceCase) =>
    conformanceCase.name.startsWith("replay/") ||
    conformanceCase.name.startsWith("race/") ||
    conformanceCase.name.startsWith("interrupt/")
})

describe("restart conformance", () => {
  for (const conformanceCase of restartable) {
    it.scoped(conformanceCase.name, () =>
      Effect.gen(function*() {
        const harness = yield* RestartableEngine.make()
        const subject = EngineSubject.make({
          ...harness.engine,
          name: "RestartableEngine/restart-on-resume",
          resume: harness.restartAndResume
        })
        yield* conformanceCase.run(subject)
      }))
  }
})
```

Swap `harness.restartAndResume` for `harness.killAndResume` to run the same
pins against the hard-kill state instead: the outgoing instance is left running
and unreleased, exactly as `SIGKILL` leaves a durable owner holding a run it
will never release. The abandoned scope still closes when the harness scope
closes, so a killed instance leaks nothing past the test. The replacement
immediately fences the old instance's store writes; late results cannot replace
a terminal outcome or append journal entries. Its current step body can still
settle inside the abandoned scope.

## What conformance does not answer

The suite is black box. It says nothing about throughput, about storage
layout, or about what happens to a real process that dies. For that last one,
see [Inject a real process fault](./inject-a-process-fault.md).

## Related

- [The engine subject seam](../concepts/engine-subject.md): the port, step
  identity, and race semantics.
- [Conformance suites](../concepts/conformance.md): why the registry is frozen
  and how parity is accounted for.
- [`@smthrs/engine`](/api/engine) and its
  [in-memory testing guide](/pkg/engine/guides/test-in-memory).
