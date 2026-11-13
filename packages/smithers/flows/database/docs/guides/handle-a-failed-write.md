---
title: "Handle a failed write"
description: "Branch on the six DatabaseError codes, keep a domain error retryable, tune or exhaust the retry budget, and watch write contention through the retry counter."
sidebar:
  order: 3
---

`DurableWriter.write` widens a caller's error channel with `DatabaseError`,
which carries one of six codes. Only `busy` was ever replayed, and by the time
you see it the budget is spent.

| Code          | What happened                                                                          | What to do                                                                                 |
| ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `busy`        | A transient lock or serialization conflict outlived the retry budget.                  | Raise `maxAttempts`, or surface it as a retryable failure to the caller.                   |
| `constraint`  | A unique or check constraint rejected the row.                                         | Branch on it. This is a decision, not a fault.                                             |
| `io`          | The disk failed. Normalized, never replayed, because the write reached the disk.       | Fail loudly.                                                                               |
| `schema`      | A statement named a table or column the database lacks: a store older than the binary. | Run the store's migrations before writing.                                                 |
| `unsupported` | The writer is the noop stub, or an affected-row count was unreadable.                  | Fix the composition, or see [Read a write's affected-row count](./count-affected-rows.md). |
| `unknown`     | A SQL failure in none of the above categories.                                         | Read `cause`. It carries the original error.                                               |

## Branch on a constraint

A unique violation is the first-writer-wins signal, so treat it as an answer
rather than an error:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"

const claim = writer.write(
  sql`INSERT INTO claims (identity) VALUES (${identity})`
).pipe(
  Effect.catchTag(
    "@smthrs/database/DatabaseError",
    (error) => error.code === "constraint" ? Effect.succeed(false) : Effect.fail(error)
  )
)
```

Where the failure has already been widened into your own error type, narrow it
with the schema rather than by tag string. This is the pattern the storage
packages use:

```ts
import { DatabaseError } from "@smthrs/database/DurableWriter"
import * as Schema from "effect/Schema"
import * as SqlError from "effect/sql/SqlError"

const isConstraint = (cause: unknown): boolean =>
  Schema.is(DatabaseError)(cause)
    ? cause.code === "constraint"
    : SqlError.isSqlError(cause) &&
      (cause.reason instanceof SqlError.ConstraintError || cause.reason instanceof SqlError.UniqueViolation)
```

The second arm matters because a statement you ran outside `write` fails with a
raw `SqlError`. Normalize it yourself with `DurableWriter.fromSqlError` and you
only have one shape to match:

```ts
sql`INSERT INTO claims (identity) VALUES (${identity})`.raw.pipe(
  Effect.mapError(DurableWriter.fromSqlError)
)
```

## Keep your own error retryable

The retry classifier walks `cause` chains, so a domain error that wraps a
transient failure still replays the outermost transaction. It only works if you
preserve the cause:

```ts
Effect.mapError((cause) => new StoreError({ message: "could not append", cause }))
```

Drop the `cause` and the chain ends at your error. The classifier finds no
`SqlError`, the write is not replayed, and a lock conflict that would have
cleared in 50 ms fails the run instead.

Do not map every failure through one sentence either. A permanent constraint
violation and a transient `busy` become indistinguishable to the caller, and
the underlying database text never surfaces at all. Carry the code:

```ts
const classify = (message: string) => (error: DurableWriter.DatabaseError) =>
  new StoreError({
    code: error.code === "constraint" ? "constraint" : "store",
    message: `${message} (database: ${error.code})`,
    cause: error
  })
```

## Do not nest a retry inside a write

A `write` inside an open transaction is a savepoint and never retries, by
design: a transient conflict has already doomed the enclosing snapshot, so
replaying the inner block cannot resolve it. Retrying it yourself with
`Effect.retry` reproduces exactly that dead end. Let the failure propagate and
let the outermost `write` replay the whole transaction body.

## Tune the budget

```ts
DurableWriter.layer({ maxAttempts: 20, baseDelayMs: 10, maxDelayMs: 500 })
```

Defaults are 10 attempts, a 50 ms base delay, and a 10 second ceiling. Jitter
is applied before the cap, so `maxDelayMs` bounds the delay that is actually
slept. A value that is not a safe integer of at least 1 clamps to 1, which
turns a typo into a single-attempt writer rather than a hang.

## Watch contention

`DatabaseMetrics.writeRetries` counts one increment per scheduled replay across
every store that writes through the boundary. A quiet system reads zero. The
attempt that finally fails is not counted, so the counter measures contention,
not failures.

```ts
import * as DatabaseMetrics from "@smthrs/database/DatabaseMetrics"
import * as Metric from "effect/Metric"

const retries = Effect.map(Metric.value(DatabaseMetrics.writeRetries), (state) => state.count)
```

The package ships the handle and no exporter. Provide one, for example from
[`@smthrs/observability`](/api/observability), and the counter appears in it.
The metric name is `flows_db_write_retries`.
