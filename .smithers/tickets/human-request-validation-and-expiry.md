# Human requests cannot be corrected after invalid input and never transition to expired

## Problem

The recent durable human-request flow adds `_smithers_human_requests`, but it is
still effectively write-once.

`smithers human answer` immediately marks a request as `answered`, then the
workflow validates the payload later inside `HumanTask`. If the JSON is invalid
or fails the output schema, the task retries, but there is no path that puts the
request back into `pending`. At the same time, the `"expired"` status and
`timeoutAtMs` field are defined and stored, but no code ever transitions a
request into `expired`.

## Evidence

1. `smithers human answer` always writes `status: "answered"` once the payload
   parses as JSON, before any task-level schema validation:
   [src/cli/index.ts](/Users/williamcory/smithers/src/cli/index.ts#L3589)
   [src/db/adapter.ts](/Users/williamcory/smithers/src/db/adapter.ts#L1377)

2. `HumanTask` performs JSON parsing and schema validation after reading the
   stored response, and throws on invalid input:
   [src/components/HumanTask.ts](/Users/williamcory/smithers/src/components/HumanTask.ts#L72)

3. Retries never reopen the request because `ensurePendingHumanRequest()` bails
   out as soon as any row already exists for that request id:
   [src/effect/deferred-state-bridge.ts](/Users/williamcory/smithers/src/effect/deferred-state-bridge.ts#L113)

4. The CLI rejects any follow-up answer once the row is no longer pending:
   [src/cli/index.ts](/Users/williamcory/smithers/src/cli/index.ts#L3567)

5. `"expired"` is part of the declared status enum, but no write path sets it,
   and inbox queries still return timed-out rows as plain pending requests:
   [src/human-requests.ts](/Users/williamcory/smithers/src/human-requests.ts#L4)
   [src/db/adapter.ts](/Users/williamcory/smithers/src/db/adapter.ts#L1339)

## Why this matters

1. A malformed or schema-mismatched answer becomes unfixable without editing the
   database manually.
2. HumanTask retries burn down `maxAttempts` against the same bad payload.
3. Timed-out requests remain visible in `smithers human inbox`, so operators can
   keep acting on work that the workflow no longer considers pending.

## Proposed solution

1. Validate `--value` against the stored human-request schema before
   `approveNode()` / `answerHumanRequest()`, or reopen the request when
   `HumanTask` throws `HUMAN_TASK_INVALID_JSON` or
   `HUMAN_TASK_VALIDATION_FAILED`.
2. Add an explicit expire path that marks timed-out rows as `expired` and stops
   listing them as pending.
3. Make follow-up answers possible for invalid human responses until the task
   successfully validates them.
4. Add end-to-end tests for:
   - invalid JSON correction
   - schema validation correction
   - timeout expiry and inbox filtering

## Severity

**MAJOR** — the new human-request subsystem has no recovery path for bad input
and leaves stale requests actionable after timeout.

## Files

- [src/components/HumanTask.ts](/Users/williamcory/smithers/src/components/HumanTask.ts)
- [src/effect/deferred-state-bridge.ts](/Users/williamcory/smithers/src/effect/deferred-state-bridge.ts)
- [src/cli/index.ts](/Users/williamcory/smithers/src/cli/index.ts)
- [src/db/adapter.ts](/Users/williamcory/smithers/src/db/adapter.ts)
- [src/human-requests.ts](/Users/williamcory/smithers/src/human-requests.ts)
