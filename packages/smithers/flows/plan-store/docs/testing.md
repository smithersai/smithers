---
title: "Testing"
description: "How to test code that persists plans: a real in-memory SQLite layer, the shared draft fixtures, and the two-connection shape the durability cases use."
---

## The harness

A store test needs a real database, not a mock: the append-only rules are
triggers, and a fake cannot raise them.
[`@smthrs/database`](/api/database) ships an in-memory SQLite layer for exactly
this, and the drafts come from [`@smthrs/plan`](/api/plan)'s own fixtures so
both sides of the split compile the same graphs.

```ts
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/plan-store/Migrations"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import * as Layer from "effect/Layer"

const stores = Layer.provideMerge(PlanStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.layer))
```

Constructing the store also asks for Effect's `Crypto` service, because
admission re-verifies every key the compiler produced.

## Two connections, one file

One in-memory connection in sequence cannot show what first-writer-wins, the
compare-and-swap append, or the one-statement read are for: the window each
closes is a _second connection_ recording, appending, or reading at the same
time. `PlanStore.concurrency.test.ts` opens two `NodeDatabase` connections on
one tmpdir file, aligns them on a latch, and asserts the durable outcome. That
is the boundary the SQLite locking protocol arbitrates; a process boundary
above it adds no further serialization.

## Assert on the refusal, not on the absence

The cases that earn their place name the code:

- A different plan under a recorded id answers `Conflict` carrying the stored
  digest, and nothing was written.
- A hand-edited stored row reads as `decode_failed` rather than as a plan.
- An append whose prefix diverges from the stored rows fails `constraint`, and
  the transaction takes its node rows back with it.
- An UPDATE or DELETE of a node row raises, because `0001_initial` installed a
  trigger for it.

## Keep resource checks independent of wall time

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

Coverage reports and V8 scratch files use a per-process directory so concurrent
package invocations cannot clean each other's reports.
