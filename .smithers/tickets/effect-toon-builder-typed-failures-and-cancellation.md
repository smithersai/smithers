# Keep TOON builder execution in typed Effect and preserve cancellation

## Problem

TOON builder execution currently drops into promise-style execution in two key places:

- `src/effect/builder.ts:962-990` uses `Effect.promise(async () => ...)` around
  nested workflow execution
- `src/effect/builder.ts:2453-2457` uses `Effect.promise(() => getToonWorkflow(path))`

These paths can reject, but `Effect.promise` is the "cannot fail" constructor. When
they reject, failures escape as defects rather than flowing through the typed
`SmithersError` channel.

There is also no proper cancellation threading into nested workflow execution, which
undermines Effect's interruption model.

## Proposal

Refactor TOON load/execute paths so they compose existing Effect programs directly.

### Preferred direction

- call `runWorkflowEffect(...)` instead of `runWorkflow(...)` from inside builder code
- use `Effect.tryPromise` / `fromPromise` only where the underlying dependency is
  truly promise-based
- map failures into `SmithersError` explicitly
- wire Effect interruption/abort signals through nested workflow execution

## Implementation

1. Replace `Effect.promise(async () => ...)` in builder execution with a fully typed
   Effect pipeline.
2. Replace `Effect.promise(() => getToonWorkflow(path))` with `fromPromise(...)` or an
   Effect-native cache/load path.
3. Prefer `runWorkflowEffect(...)` inside the builder so the nested run stays in
   Effect until the outermost boundary.
4. Preserve existing result semantics for:
   - finished
   - waiting-approval
   - waiting-timer
5. Convert load/execute failures into stable `SmithersError` codes instead of defects.

## Additional Steps

1. Audit the rest of `src/effect/builder.ts` for similar promise-shaped islands.
2. Check whether `resolveEffectResult(...)` should be narrowed so Effect-returning user
   steps stay in Effect without extra unwrap/re-wrap logic.
3. Decide whether `getToonWorkflow(...)` caching should be stored as Effects, not raw
   promises.

## Verification requirements

### Failure behavior

1. If `getToonWorkflow(...)` rejects, `loadToon(...).execute(...)` should fail with a
   typed `SmithersError`, not a defect.
2. If nested `runWorkflow` fails, the outer Effect should fail in the normal error
   channel with stable error codes.
3. Add a regression test for builder execution when a nested workflow returns a
   waiting state.

### Cancellation

4. Interrupt a TOON execution fiber while nested workflow execution is in flight; the
   nested work must observe cancellation.
5. Verify abort signals are propagated correctly to nested run boundaries.

### Regression coverage

6. Extend `tests/effect-builder.test.ts`; the current tests only validate basic shape
   and lazy loading.
7. Keep existing `tests/toon.test.ts` behavior unchanged for successful runs.

## Observability

### Logging

- `Effect.withLogSpan("toon:load")`
- `Effect.withLogSpan("toon:execute")`
- Annotate with `{ workflowPath, workflowName }`

### Metrics

- `smithers.toon.load_ms`
- `smithers.toon.execute_ms`
- `smithers.toon.failures_total`

## Codebase context

- `src/effect/builder.ts:518-539`
- `src/effect/builder.ts:962-990`
- `src/effect/builder.ts:2410-2457`
- `src/engine/index.ts:5374-5389`

## Effect.ts architecture

Builder code is internal orchestration logic, not a user boundary. It should stay in
typed Effect end-to-end. Use `Effect.promise` only for operations that are guaranteed
not to reject.
