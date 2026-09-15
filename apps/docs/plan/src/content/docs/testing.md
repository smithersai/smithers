---
title: "Testing"
description: "How to test code that builds plans: the one service to provide, a real in-memory store, and the assertions worth writing."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/testing.md"
---

## Testing code that builds plans

Compiling asks for Effect's `Crypto` service and nothing else, so a plan test
needs one layer:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provide(effect, NodeCrypto.layer)

/** The same, for an Effect expected to fail: yields the typed error. */
export const withCryptoFailure = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<E, A> =>
  withCrypto(Effect.flip(effect))
```

Those two helpers are the whole harness. No clock, no filesystem, and no fake
anything: a plan is a pure function of its declarations, so a plan test is an
ordinary value test.

Testing persistence adds a database. [`@smthrs/database`](https://database.smithers.sh/reference/api/) ships a
real in-memory SQLite layer for exactly this, so a store test exercises the
append-only triggers rather than a mock that cannot raise them:

```ts
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/plan/Migrations"
import * as PlanStore from "@smthrs/plan/PlanStore"
import * as Layer from "effect/Layer"

const stores = Layer.provideMerge(PlanStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.layer))
```

### Assert on keys, not on shape

A plan's value is that identity is computable. The assertions that earn their
place say so:

- An edit re-keys its node and its dependent cone, and nothing else.
- A rename re-keys nothing, because ids are lookup addresses.
- An ordering edge, a priority change, or a conflict annotation leaves every key
  where it was.
- Compiling the same drafts twice produces the same digest.

### Mutate the caller's draft after compiling

A compiled plan is a deep-frozen snapshot. The cheapest proof is to compile,
mutate the object you passed in, and assert the stored material and the plan
digest did not move. The values worth trying are a `Date`, a `URL`, and an
object with a custom `toJSON`, because each one keys through a different path.

### Keep fixtures out of test modules

Importing a `*.test.ts` module registers its suites in the importer, so shared
fixtures belong in an ordinary module. When one suite pulls a helper out of
another suite's file, it re-runs every case in that file, and a fast suite
inherits a slow one's runtime and its timeouts for work it never asked for.

### Keep resource checks independent of wall time

The package runs files serially, including the dense compiler cases with their
original graph sizes, digest and edge-order assertions. FileSet's synchronous
adversarial matcher tests charge thread CPU time against the existing 100 ms
budget, excluding descheduling and work on other threads.

The append regression observes real SQLite query spans through 300 generations.
Each successful append must authenticate the stored envelope and insert one new
node and edge without reading or rewriting stored node rows. The complete ordered
statement list must match the envelope CAS and those two inserts, so unexpected
queries cannot escape through quoted identifiers or alternate SQL syntax. A
negative control reads, decodes and verifies all 45,150 prefix rows across the
same 300 generations using SQLite's quoted identifier helper; the shared query
assertion must reject every injected read. A final verifying read in both cases
must reproduce the complete plan. This checks the persistence work directly;
a wall-time ratio between early and late appends also measures unrelated machine
load, while prefix hashing still depends on the plan's size.

The planned-value lint test builds a dedicated consumer fixture project against
the real Node types. It asserts the exact conditional-truthiness diagnostics
without asking the editor project service to discover other workspace projects.
An isolated Node 24 run measured 6.96 seconds user plus 1.56 seconds system CPU
with `/usr/bin/time -p`. This case alone allows 70 seconds: eight times that CPU
cost, rounded up, for a heavily shared host. The package's 30-second default is
unchanged. Coverage reports and V8 scratch files use a per-process directory so
concurrent package invocations cannot clean each other's reports.
