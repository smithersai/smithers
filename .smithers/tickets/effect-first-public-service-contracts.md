# Convert RAG, memory, and voice contracts to Effect-first APIs

## Problem

Several core services already have Effect implementations, but their public contracts
are still Promise-first:

- `src/rag/types.ts:77-103`
- `src/memory/store.ts:31-62`
- `src/memory/semantic.ts:17-23`
- `src/voice/types.ts:87-120`

That forces callers to break out of Effect with `runPromise(...)`, then often wrap the
result back into Effect later. The result is:

- duplicate Promise and Effect surfaces throughout the codebase
- higher risk of choosing the wrong wrapper (`fromSync` vs `fromPromise`)
- weaker typed-error propagation at composition boundaries
- less leverage from Effect services/layers/scopes

This is architectural drift away from idiomatic Effect.

## Proposal

Make Effect the canonical contract for internal services and keep Promise helpers as
thin compatibility adapters.

### Target direction

- `VectorStore` becomes Effect-first
- `RagPipeline` becomes Effect-first
- memory store / semantic memory contracts become Effect-first
- voice services become Effect-first at least inside Smithers internals

### Compatibility

If external users need Promise APIs, keep them as wrappers implemented with
`runPromise(...)` at the outer edge.

## Implementation

1. Introduce canonical Effect interfaces for RAG, memory, and voice.
2. Migrate internal callers to the Effect interfaces first.
3. Collapse duplicate Promise+Effect method pairs where possible.
4. Keep Promise adapters only for:
   - public library entry points
   - UI/component boundaries
   - tests that intentionally exercise Promise ergonomics
5. Update docs so Effect usage is the recommended path.

## Additional Steps

1. Audit all `runPromise(...)` calls in internal modules and classify them:
   - required boundary
   - removable once contracts are Effect-first
2. Add naming conventions so canonical interfaces are obvious.
3. Consider exposing service layers for RAG and voice similar to `MemoryService`.
4. If database-backed vector/memory operations continue to grow, evaluate whether
   `@effect/sql` should become the primary DB abstraction instead of mixed
   Drizzle+manual interop.

## Verification requirements

### Architectural regression checks

1. Internal modules composing RAG/memory/voice should no longer need `runPromise(...)`
   except at explicit boundaries.
2. Add tests that exercise the Effect-first contracts directly.
3. Preserve existing Promise-facing behavior for compatibility where promised in docs.

### Static/code review checks

4. Add a lightweight rule or review checklist: internal modules should not introduce
   new Promise-first service contracts when an Effect service exists.
5. Audit and remove redundant Promise+Effect duplication where the Promise surface is
   unused internally.

## Observability

No new runtime metrics are required, but after this refactor:

- existing spans should become more continuous across RAG/memory/voice flows
- typed failures should surface in normal logs instead of defect-style rejections

## Codebase context

- `src/rag/types.ts`
- `src/rag/pipeline.ts`
- `src/rag/vector-store.ts`
- `src/memory/store.ts`
- `src/memory/semantic.ts`
- `src/memory/service.ts`
- `src/voice/types.ts`
- `src/voice/effect.ts`

## Effect.ts architecture

Internal Smithers code should treat Effect as the default programming model.
Promise-based APIs are acceptable as compatibility shims at product/library
boundaries, but they should not be the canonical contracts that internal modules build
on top of.
