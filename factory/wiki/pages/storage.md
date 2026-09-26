# Journal and durable stores

The shared runtime composes the journal and durable stores over an injected database. Coding work should reuse these records rather than open a second ledger.

## Share the injected database

The shared `@smthrs/flows/Runtime.storage` composition builds journal and durable store layers over injected services; it does not select a SQL driver. The native Node and Bun compositions supply that driver, and stores use the existing `DurableWriter` transaction policy.

Coding plans, checks, results, waits and recovery should use the current flow execution identity and the existing durable stores. A product-specific projection may have its own migration namespace in the injected database. It must not create a separate connection, job queue, command ledger or lease system.

## The journal is the run's history

`@smthrs/journal` records what a long-running piece of work did, in order, in SQLite. Rows are appended and never updated.

- A lifecycle event is on disk before its call returns. A telemetry event goes through a bounded queue that drops under pressure. Both land in one per-run sequence.
- An emission returns `Accepted`, `Duplicate` or `Dropped`.
- Producer identity is `(runId, sourceId, sourceSeq)`, so a replay after a crash gets `Duplicate` rather than doubling history.
- Payloads are scrubbed of credentials on the write path, before encoding.
- The durable channel takes an owner token; a replaced process fails with `fence_lost`.
- A checkpoint pins replay state to a sequence, and compaction deletes the entries below it.

## The run store owns run state and ownership

`@smthrs/run-store` provides `RunStore` and `AttemptStore`. `RunStore` keeps one row per run with its status, owner, heartbeat, cancellation request and the executable state a resume re-enters. An owner identity is `{ hostId, pid, nonce }`, compared inside the same SQL statement as the mutation it guards. Losing a race returns `AlreadyClaimed`, `HeartbeatFresh` or `FenceLost` as a success value. `AttemptStore` records each step attempt and refuses writes from a process that no longer owns the run.

## Other facts live in neighboring stores

Sealed step results live in `@smthrs/step-cache`. Durable deferred and clock tables live in `@smthrs/engine-store`, which composes all of these stores. `@smthrs/database` is the single write boundary they share.
