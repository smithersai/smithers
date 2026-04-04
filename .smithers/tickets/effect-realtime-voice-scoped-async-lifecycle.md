# Rebuild realtime voice around scoped Effect async lifecycle management

## Problem

The realtime voice provider currently uses unmanaged promises and listener arrays for
core control flow:

- `src/voice/realtime.ts:234-255` waits for speaker output with a raw `Promise`
- `src/voice/realtime.ts:276-308` waits for transcript completion with a raw `Promise`
- `src/voice/realtime.ts:377-381` waits for websocket open/session-created with raw
  promises

Those promises only resolve on the happy path. There is no structured rejection,
timeout, or interruption handling for websocket `error`/`close` events, so failures
can leave callers waiting forever and listeners retained indefinitely.

This is exactly the kind of streaming lifecycle that should be modeled with Effect
resources and `Deferred`.

## Proposal

Move realtime voice session management to Effect-native async/resource primitives.

### Preferred direction

- model session state with `Deferred`
- use `Effect.async` or `Effect.asyncInterrupt` for websocket callbacks
- use `Scope` / `acquireRelease` to guarantee listener cleanup
- represent connection/session readiness as an Effect resource, not ad hoc promises

### Optional library evaluation

Evaluate whether `@effect/platform` websocket / stream abstractions can replace some
of the manual event plumbing. If not, still keep the public model scoped and
interrupt-safe.

## Implementation

1. Wrap websocket connection lifecycle in `Effect.acquireRelease`.
2. Convert `connect`, `speak`, and `listen` wait paths to `Deferred`-based effects.
3. Reject on websocket `error` and `close` where appropriate.
4. Add cancellation/timeout handling so a caller can interrupt a pending realtime
   operation.
5. Ensure event listeners are removed when operations complete or are interrupted.
6. Decide whether `VoiceProvider` itself should gain Effect-native methods or whether
   the Effect service layer owns the conversion.

## Additional Steps

1. Review `src/voice/effect.ts`; it currently wraps Promise-based provider methods and
   would become much simpler if the provider or service were Effect-first.
2. Review `src/voice/composite.ts` so composite routing preserves interruption and
   cleanup.
3. Review the AI SDK voice provider for any similar stream lifecycle issues.

## Verification requirements

### Failure and cleanup

1. If the websocket errors before `session.created`, `connect` must fail instead of
   hanging.
2. If the websocket closes while `speak` is waiting for `speaker`, the effect must
   fail and remove its listener.
3. If the websocket closes while `listen` is waiting for transcript completion, the
   effect must fail and remove its listener.
4. Interrupt a pending `connect`/`speak`/`listen` effect and assert all listeners are
   cleaned up.

### Timeouts and cancellation

5. Add timeout coverage for the session-created wait path.
6. Verify user-provided abort/cancel signals are respected.

### Regression coverage

7. Extend `tests/voice/realtime.test.ts`; current tests only cover shape and trivial
   local behavior.

## Observability

### Logging

- `Effect.withLogSpan("voice:realtime:connect")`
- `Effect.withLogSpan("voice:realtime:speak")`
- `Effect.withLogSpan("voice:realtime:listen")`

### Metrics

- `smithers.voice.realtime_connect_ms`
- `smithers.voice.realtime_failures_total{phase}`
- `smithers.voice.realtime_pending_ops`

## Codebase context

- `src/voice/realtime.ts:61-203`
- `src/voice/realtime.ts:211-255`
- `src/voice/realtime.ts:257-308`
- `src/voice/realtime.ts:360-402`
- `src/voice/effect.ts:29-83`
- `src/voice/types.ts:87-120`

## Effect.ts architecture

Realtime voice is long-lived async resource management. It should use Effect's scoped
resource and callback primitives instead of raw promises and mutable listener arrays.
