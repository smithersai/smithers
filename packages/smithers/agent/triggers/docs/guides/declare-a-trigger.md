---
title: "Declare and register a trigger"
description: "Write a trigger declaration, validate it before it reaches the database, register it durably, and edit or disable it afterwards."
sidebar:
  order: 1
---

A trigger is a row: which flow to run, with what input, on what schedule.
This guide takes one from a literal to a durable registration.

## Write the declaration

Nine fields, of which four have defaults:

```ts
import * as Trigger from "@smthrs/triggers/Trigger"

const declaration = {
  id: "nightly-report",
  flowId: "reports/nightly",
  input: { channel: "#ops" },
  cron: "0 3 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "one",
  maxCatchUp: 1,
  enabled: true
}

const nightly = Trigger.make(declaration)
```

| Field        | Required | Meaning                                                                        |
| ------------ | -------- | ------------------------------------------------------------------------------ |
| `id`         | yes      | The trigger's identity. Registering the same id again replaces the row.        |
| `flowId`     | yes      | The flow the launch names. Resolved by the control plane, not by this package. |
| `input`      | yes      | The flow's input. Must be JSON.                                                |
| `cron`       | yes      | A cron expression. Refused if the calendar never satisfies it.                 |
| `timezone`   | no       | An IANA timezone name. Omit for the host's interpretation.                     |
| `overlap`    | no       | Defaults to `skip`.                                                            |
| `catchUp`    | no       | Defaults to `none`.                                                            |
| `maxCatchUp` | no       | Defaults to 0. Must be between 0 and 1000.                                     |
| `enabled`    | yes      | A disabled trigger is listed but never claimed.                                |

`input` is typed as JSON rather than `unknown` because the store persists it
with `JSON.stringify` into a `NOT NULL` column. The type refuses what that call
would drop or rewrite: `undefined`, `NaN`, a `Date`, and a function are each
rejected here, where the failure names the field, instead of reaching the column
as a write error or a silently changed value.

## Validate before you persist

`Trigger.make` decodes the declaration, applies the three policy defaults, and
runs the satisfiability probe. It fails with `invalid_trigger` for a shape
problem and with `invalid_cron` or `unsatisfiable_cron` for a schedule problem.
`TriggerError.path` names the offending field:

```ts
import * as Trigger from "@smthrs/triggers/Trigger"
import * as Effect from "effect/Effect"

const refused = Effect.flip(Trigger.make({ ...declaration, cron: "0 0 30 2 *" }))
// TriggerError { code: "unsatisfiable_cron", message: "cron expression '0 0 30 2 *' has no next occurrence" }
```

To validate a schedule on its own, without a flow id or an input, use
`Schedule.make`. It reports the same schedule failures under
`invalid_schedule`.

## Register it

`register` is an upsert. It writes the row and answers with a `Registered`,
which is the declaration plus the two fields the store owns:

```ts
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import * as Effect from "effect/Effect"

const registered = Effect.gen(function*() {
  const store = yield* TriggerStore.TriggerStore
  const trigger = yield* Trigger.make(declaration)
  return yield* store.register(trigger)
  // { ...declaration, revision: 1, lastFiredAt: undefined }
})
```

- `revision` starts at 1 and increments on every re-registration of the same
  id. A scheduler carries it into each claim, so an edit invalidates in-flight
  decisions rather than racing them. See
  [the claim protocol](../concepts/claim-protocol.md).
- `lastFiredAt` is absent until an occurrence is recorded. Its absence is what
  tells the first tick that this trigger owes no history.

`SqlTriggerStore.register` re-validates the declaration itself, so a caller that
bypassed `Trigger.make` still cannot write an unsatisfiable cron into the
database.

## Edit or disable it

There is no separate update or delete method. Register the same id again with
the fields you want:

```ts
import * as Effect from "effect/Effect"

const paused = Effect.gen(function*() {
  const store = yield* TriggerStore.TriggerStore
  const trigger = yield* Trigger.make(declaration)
  return yield* store.register({ ...trigger, enabled: false })
  // revision: 2
})
```

A disabled trigger stays in `list` and disappears from `listEnabled`. A claim
against it fails with `trigger_disabled`, which is the refusal a scheduler that
was mid-decision receives.

## Read the state back

| Method                 | Answers                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `get(triggerId)`       | `Option<Registered>` for one trigger.                                             |
| `list()`               | Every trigger, ordered by id, as `Listed` rows. This is what the scheduler polls. |
| `listEnabled()`        | Every enabled trigger, ordered by id.                                             |
| `activeRun(triggerId)` | `Option<string>`: the run id or launch reservation currently held.                |

A tick polls `list`, not `listEnabled`, because a disabled trigger can still
hold an active occurrence that has to recover; the tick skips only its new
claims. Neither listing is a due-time query. Due-ness is computed by the
scheduler against the cron expression and its own watermark.

## Next

- [Choose an overlap and catch-up policy](./choose-a-policy.md).
- [Run the scheduler in a host](./run-the-scheduler.md), which is what turns a
  registered row into a launch.
