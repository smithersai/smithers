---
title: "Durable values"
description: "How run state, checkpoints, errors, outcomes, and metadata cross the persistence boundary: inert copies, shape limits rather than byte limits, the one configurable ceiling, and why nothing is redacted."
sidebar:
  order: 4
---

Every value these stores persist is executable resume data. A run's
`stateJson` is what a restarted process re-enters; an attempt's checkpoint is
where a retried step picks up. That single fact decides every rule on this
page.

## Values are copied inert before anything can yield

A JavaScript object handed to a store is not trusted to hold still. Before
persistence can yield, the boundary walks the value and builds a detached copy,
reading only own enumerable data properties. What it refuses:

- **Accessors.** A getter would run application code inside the persistence
  path, and could return different values to the validator and to the writer.
- **`toJSON` and non-plain objects.** A prototype other than `Object.prototype`
  or `null` is refused, so a class instance never persists as whatever its
  serializer felt like emitting.
- **Cycles**, sparse arrays, enumerable non-index array members, enumerable
  symbols, and non-finite numbers.
- **Ill-formed text.** A lone UTF-16 surrogate or an embedded NUL is refused,
  because it would not survive the round trip through SQLite unchanged.

The copy is frozen, so what was validated is what gets written. Stored rows are
validated again on the way out: a row edited by something other than these
stores fails with `decode_failed` rather than being handed back as state.

## The bounds are on shape, not on size

Run state, metadata, errors, and outcomes have no byte ceiling, on purpose.
These rows are what a resume re-enters, so a multi-megabyte state a flow
legitimately produced has to persist or the run cannot continue. What is
bounded is shape, and the limits are public constants:

| Constant                        | Value   | Applies to            |
| ------------------------------- | ------- | --------------------- |
| `RunStore.maximumRunJsonDepth`  | 128     | Executable run state. |
| `RunStore.maximumRunJsonNodes`  | 100,000 | Executable run state. |
| `AttemptStore.maximumJsonDepth` | 128     | Every attempt value.  |
| `AttemptStore.maximumJsonNodes` | 100,000 | Every attempt value.  |

Depth bounds the recursion the boundary itself performs. Node and member counts
bound the work one admission can cost. A value past either is refused with
`invalid_run` or `invalid_attempt` and a complaint naming the limit it broke.

## The one byte ceiling is the checkpoint

A checkpoint is the exception, because it is a convenience rather than a
requirement: a step that cannot checkpoint still runs, it just restarts from
the beginning. So it takes a policy:

```ts
import { AttemptStore } from "@smthrs/run-store"

const attempts = AttemptStore.layerWith({ maxCheckpointBytes: 4 * 1024 * 1024 })
```

`Options.maxCheckpointBytes` defaults to 1 MiB and may not exceed
`AttemptStore.maximumCheckpointBytes`, which is 16 MiB. A larger value is
refused when the store is built, not when the first oversized checkpoint
arrives.

## Identifiers are bounded durable text

Run ids, step key digests, lineage ids, owner host ids and nonces, and attempt
state names are all validated the same way: non-empty, at most 1,024 UTF-16
units, no NUL, and no lone surrogate. `U+FFFD` is ordinary text and is
accepted; an astral character round-trips byte for byte.

## Timestamps are checked independently

Every timestamp must be a non-negative safe integer, and each is range-checked
on its own. None is compared against another. An attempt whose `finishedAtMs`
precedes its `startedAtMs` persists exactly as written, because the store does
not adjudicate the caller's timeline: it records what the caller observed.

The two exceptions are the ones that are lease predicates rather than records.
Heartbeats are monotonic, and lease readings are bounded by the skew allowance.
Both are covered in [The heartbeat lease](./leases.md).

## Nothing is redacted

The stores rewrite no field on the way through. A redactor here would silently
change what the flow re-reads on resume, which corrupts the run rather than
protecting it: a field named `token` in executable state is state, and a run
that resumes without it is broken.

`Schema.Redacted` hides inspection but allows schema JSON encoding by default.
`Schema.encodeSync(Schema.toCodecJson(schema))` unwraps a default `Redacted`
field, and the store persists the resulting credential bytes. Refuse JSON
encoding explicitly for values that must never be persisted:

```ts
const RuntimeState = Schema.Struct({
  apiKey: Schema.Redacted(Schema.String, { disallowJsonEncode: true })
})
```

This rejects serialization; it does not omit the field. For resumable state,
use a persistence schema that excludes credentials and stores a secret
reference instead:

```ts
const PersistedState = Schema.Struct({
  secretRef: Schema.String,
  pageToken: Schema.String
})
```

Resolve `secretRef` from a secret provider on resume. Persist only the
reference and flow data, never the resolved credential. Values that must not
be published are handled on the journal-event and export surfaces, which is
where the observability boundary lives.

### The run file is a secret store

Two columns keep run values verbatim because resume re-reads them byte for
byte:

- `flows_runs.state_json` holds the run's payload and result.
- `flows_attempts.outcome_json` holds each action's encoded result, which an
  action replays instead of executing again.

A credential in a payload, or spliced into an action's success value, is
stored in cleartext in the run's SQLite file (`.flows/*.db`). Handle that file
as a secret store: restrict its permissions, keep it out of commits, bug
reports, and artifacts, and delete it when the run is no longer needed. The
journal table is redacted on the write path; the fault suite's case 22 scans
every table and fails on a credential in any other column.

The stores hold that line in their own diagnostics as well. Failure causes
reach logs, spans, and telemetry, so they carry field names, lengths, and
validity flags, and never the rejected payload. Malformed timestamp causes
contain only the field name and a fixed validation complaint. Clock-skew
diagnostics include timestamp readings only after numeric validation.
