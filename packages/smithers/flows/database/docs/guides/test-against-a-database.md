---
title: "Test against a database"
description: "Run tests against the production client on an in-memory database, drive the retry schedule with TestClock, observe the retry counter through your own registry, and use the noop writer where a database is not the subject."
sidebar:
  order: 5
---

Tests against this package do not need a fake. The production client opens an
in-memory database in microseconds, the retry schedule sleeps on the injected
clock, and the retry counter lands in whichever metric registry you provide.

## Use the in-memory database

`TestDatabase.layer` is the production Node client and the production writer
over a fresh `:memory:` database:

```ts
import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

describe("my store", () => {
  it.effect("writes and reads back", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      yield* writer.write(sql`CREATE TABLE rows (id INTEGER PRIMARY KEY)`)
      yield* writer.write(sql`INSERT INTO rows (id) VALUES (1)`)
      const rows = yield* sql<{ readonly id: number }>`SELECT id FROM rows`
      expect(rows).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(TestDatabase.layer)))
})
```

Add your migrations on top when the test needs tables:

```ts
Effect.provide(Layer.provideMerge(Migrations.layer([set]), TestDatabase.layer))
```

Note what the in-memory layer cannot show you. `:memory:` is private to a
connection, so both handles are the same connection: serialization comes from
the client's in-process transaction mutex rather than from the database, and
there is no second connection to produce a genuine `SQLITE_BUSY`. Anything that
turns on cross-connection behavior needs a file.

## Use a file when connections are the subject

Two `NodeDatabase.layer` builds over one temporary file give you two real
connections. Writable Node clients default to a `busyTimeout` of `0`, so
contended attempts fail immediately and the writer retries cooperatively.
Set a small nonzero timeout only when the test needs a synchronous lock wait:

```ts
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Duration from "effect/Duration"

NodeDatabase.layer({
  filename: join(directory, "contract.sqlite"),
  sqlite: { busyTimeout: Duration.millis(5) }
})
```

## Drive the retry schedule with TestClock

Retry delays use Effect's `Clock`, so a test states the passage of time instead
of sleeping through it:

```ts
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"

const replayed = Effect.gen(function*() {
  const fiber = yield* writer.write(flaky).pipe(Effect.forkChild({ startImmediately: true }))
  yield* Effect.yieldNow
  yield* TestClock.adjust("1 second")
  return yield* Fiber.join(fiber)
})
```

Fork first, let the fiber reach its first failure, then advance the clock. A
write awaited directly never yields, so the clock never moves.

## Count retries through your own registry

`DatabaseMetrics.writeRetries` writes into whichever `Metric.MetricRegistry` is
in context, so a test observes contention without touching a global:

```ts
import * as DatabaseMetrics from "@smthrs/database/DatabaseMetrics"
import * as Metric from "effect/Metric"

const registry = new Map()
const retries = Effect.map(Metric.value(DatabaseMetrics.writeRetries), (state) => state.count)

const program = Effect.gen(function*() {
  const before = yield* retries
  yield* underTest
  return (yield* retries) - before
}).pipe(Effect.provideService(Metric.MetricRegistry, registry))
```

Three attempts means exactly two scheduled replays: the first attempt and the
final success are not retries.

## Provide the noop writer where a database is not the subject

`DurableWriter.layerNoop` satisfies the service and fails every write with
`unsupported`. Use it to prove that a code path does not write, or to compose a
service whose database half is out of scope. `makeNoop()` is the same stub as a
value.

## Substitute a client, not the writer

Where you need to force a specific driver failure, build the writer over a
stubbed `SqlClient` with `DurableWriter.make(sql, options)` and let the real
policy run against it. Stubbing `write` itself removes the classification, the
savepoint nesting, and the retry accounting, which is the behavior the test
exists to exercise.
