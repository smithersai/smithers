# Make Alerts First-Class Durable Records

## Problem

`_smithers_alerts` is real, but the row shape is too thin for actionable alerts. It cannot carry enough structured context for dedupe, recurrence, runbook ownership, alert actions, or silence TTLs. The merged `alertPolicy` also is not persisted per run, so resume and hot-reload behavior cannot be deterministic.

## Proposed Changes

- Extend the alert data model in `src/db/internal-schema.ts` and `src/effect/sql-message-storage.ts` with the fields needed for real operator workflows.
- Keep existing columns for backward compatibility, but add structured fields for the data the UI and runtime need to query directly.
- Persist the effective merged `alertPolicy` snapshot into the run's durable config at run start and resume, so the evaluator is replayable and inspectable.
- Expand the adapter API in `src/db/adapter.ts` from "insert/list/ack/resolve/silence" into a full alert lifecycle API that supports:
  - lookup by fingerprint
  - reopen on recurrence
  - silence with expiry
  - actor attribution for ack/resolve
  - list by run and by active status

## Required Model Additions

- `fingerprint`
- `nodeId`
- `iteration`
- `owner`
- `runbook`
- `labelsJson`
- `reactionJson`
- `sourceEventType`
- `firstFiredAtMs`
- `lastFiredAtMs`
- `occurrenceCount`
- `silencedUntilMs`
- `acknowledgedBy`
- `resolvedBy`

`detailsJson` should remain the escape hatch for rich structured context, but it should no longer be the only place where critical query fields live.

## Touch Points

- `src/SmithersWorkflowOptions.ts`
- `src/engine/index.ts`
- `src/db/internal-schema.ts`
- `src/effect/sql-message-storage.ts`
- `src/db/adapter.ts`
- `src/cli/index.ts`

## Dependencies

- None

## Acceptance Criteria

- Existing databases migrate forward without dropping prior alert rows.
- The effective merged `alertPolicy` is stored durably with the run and available on resume.
- The adapter can reopen an alert by fingerprint instead of creating duplicate active rows.
- Silence can be expressed as a TTL instead of a permanent terminal state only.
- `smithers alerts list|ack|resolve|silence` still works against the new schema.
- Adapter tests cover migration, reopen, silence expiry metadata, and actor fields.
