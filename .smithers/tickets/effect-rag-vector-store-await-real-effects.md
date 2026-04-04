# Fix RAG vector-store Effect wrappers so they await real work

## Problem

The exported RAG vector-store Effect wrappers currently wrap async methods with
`fromSync`:

- `src/rag/vector-store.ts:164-174` wraps `store.upsert(...)`
- `src/rag/vector-store.ts:177-192` wraps `store.query(...)`

But `VectorStore` itself is Promise-based:

- `src/rag/types.ts:77-84`

That means these wrappers complete with `Promise` values instead of awaited results.
Practical consequences:

- `ragRetrieveDuration` is measured before the query finishes
- async failures bypass the intended `SmithersError` channel
- callers can accidentally believe they are still "inside Effect" when they are not

This is a correctness bug, not just a style issue.

## Proposal

Make the vector-store API effect-native or, at minimum, ensure every Effect wrapper
uses `Effect.tryPromise` / `fromPromise` for async methods.

### Minimum fix

- Replace `fromSync` with `fromPromise` in `upsertEffect` and `queryEffect`

### Better direction

- Redesign `VectorStore` as an Effect-first interface
- Keep Promise helpers only as compatibility adapters at the public boundary

## Implementation

1. Change `upsertEffect` to await `store.upsert(...)` via `fromPromise`.
2. Change `queryEffect` to await `store.query(...)` via `fromPromise`.
3. Revisit `delete` and `count` and decide whether they also need Effect variants.
4. Audit nearby modules to keep the pipeline unbroken:
   - `src/rag/pipeline.ts`
   - `src/memory/semantic.ts`
5. Ensure timing metrics wrap the actual awaited operation.

## Additional Steps

1. Decide whether `createSqliteVectorStore` should expose:
   - only Effect methods
   - or both Effect and Promise methods
2. If both are kept, make the Effect surface canonical and implement Promise helpers
   in terms of `runPromise(...)` only at outer boundaries.
3. Document the rule for future RAG integrations: async work never goes through
   `fromSync`.

## Verification requirements

### Correctness

1. Add a test where `store.query(...)` resolves after a delay; assert `queryEffect`
   waits for completion and returns concrete results, not a `Promise`.
2. Add a test where `store.query(...)` rejects asynchronously; assert the failure is
   captured as an Effect failure.
3. Add a test where `store.upsert(...)` rejects asynchronously; assert the error is
   typed and logged.
4. Assert `ragRetrieveDuration` and any ingest metrics are recorded after the async
   operation completes.

### Regression coverage

5. Keep existing `tests/rag/vector-store.test.ts` passing.
6. Add a new suite for the Effect wrappers specifically; current tests only exercise
   the Promise surface.

## Observability

### Logging

- `Effect.withLogSpan("rag:vector-upsert")`
- `Effect.withLogSpan("rag:vector-query")`
- Annotate with `{ namespace, topK, count }`

### Metrics

- existing RAG metrics should reflect actual operation latency, not wrapper latency

## Codebase context

- `src/rag/types.ts:77-84`
- `src/rag/vector-store.ts:164-192`
- `src/rag/pipeline.ts:59-87`
- `src/memory/semantic.ts:67-95`

## Effect.ts architecture

RAG is internal orchestration code. It should remain in Effect until the final public
API edge. Do not use sync wrappers around async methods.

If the repo continues to support a Promise-first public RAG API, treat that as a thin
interop layer only.
