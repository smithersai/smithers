# @smthrs/plan-store

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/plan-store/docs

Durable, append-only persistence for a [`@smthrs/plan`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/plan/docs) plan.

A plan is an inert value: nodes, edges, computed keys, effect declarations,
conflict annotations, and the digest a run's approval binds to. Compiling one
needs nothing but cryptography, which is why the plan package performs no I/O
at all. This package is where the compiled value is kept, so only a caller that
actually persists installs a database.

Growth is append-only and the SQL enforces it. `append` inserts the newest
generation's rows and advances the plan row's digest under a compare-and-swap;
no verb here rewrites or deletes a node, and a trigger refuses one anyway.

## Install

```bash
npm install @smthrs/plan-store@next effect
```

It needs Node.js 22.19.0 or later and `effect` `4.1.1`. The root names no
database driver, so it bundles for the browser; the driver layers a durable
composition adds are on the
[installation page](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/docs/installation.md).

## Record a plan and read it back

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as Plan from "@smthrs/plan/Plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

const layer = PlanStore.layer.pipe(
  Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))),
  Layer.provideMerge(NodeCrypto.layer)
)

const main = Effect.gen(function*() {
  const store = yield* PlanStore.PlanStore
  const plan = yield* Plan.compile({
    planId: "plan-1",
    flow: "example/Build",
    nodes: [{
      id: "compile",
      material: {
        version: "flows/key-material/v2",
        kind: "sealed",
        body: { action: "compile" },
        inputs: [],
        layers: [],
        capabilities: []
      },
      effects: { reads: ["src"], writes: ["dist"], boundaryMode: "hard" }
    }]
  })
  console.log((yield* store.record(plan, 0))._tag)
  console.log(Option.isSome(yield* store.get("plan-1")))
})

Effect.runPromise(Effect.provide(main, layer).pipe(Effect.orDie))
```

```text
Recorded
true
```

## What it does that an INSERT does not

- **Admission verifies the compiler's work.** `record` and `append` rebuild
  every key and digest before a row is written, and `get` verifies again before
  a plan is returned, so a hand-edited row reads as `decode_failed` instead of
  as a plan.
- **Recording is first-writer-wins.** `record` answers `Recorded`,
  `ExistingSame`, or `Conflict`. `ExistingSame` is only answered after the
  stored plan verifies, so a corrupt row can never pass as an identical
  re-record.
- **Appending is a compare-and-swap over the whole envelope.** The UPDATE
  matches the previous generation, the flow, the approved base digest, and the
  running prefix digest, which proves the recorded prefix is the one this
  append grew from without reading a node row.
- **Append-only is a trigger, not a convention.** Rewriting a node, deleting a
  plan, or moving a generation backwards is an error the database raises.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/plan-store/<Module>`. Every export, with its signature and its
guarantees, is on the
[API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/docs/api.md).

| Namespace    | What it is                                                         |
| ------------ | ------------------------------------------------------------------ |
| `PlanStore`  | The service contract, its SQL implementation, and its error codes. |
| `Migrations` | The namespaced migration set that creates the three tables.        |

## Documentation

- [Overview](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/plan-store/docs)
- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/docs/quickstart.md)
- [Persist a plan](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/docs/guides/persist-a-plan.md)
- [Append a generation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/docs/guides/append-a-generation.md)
- [Testing](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/docs/testing.md)
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan-store/docs/troubleshooting.md), which
  lists every failure message, what causes it, and what to change.

## License

MIT. See [LICENSE](./LICENSE).
