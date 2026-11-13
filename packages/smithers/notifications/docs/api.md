---
title: "API reference"
description: "Every public export of @smthrs/notifications: the queue service and its layers, the notification and event schemas, the pure state machine, the steering vocabulary, the alert policy, the per-person inbox rules, and the email and Telegram delivery channels."
---

Every module is importable as a namespace from the root entry point and from its
own subpath:

```ts
import { Alerts, Notification, NotificationQueue } from "@smthrs/notifications"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
```

Types written below as `Schema` are `effect` schemas; each one exports a value
and a type of the same name, and the type is the decoded form.

## Example

```ts
import { NotificationQueue } from "@smthrs/notifications"

const deliver = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue
  const receipt = yield* queue.drain({
    runId: "run-1",
    targetLineageId: "run-1/root",
    boundary: "turn-1",
    wouldIdle: true
  })
  return receipt.notifications
}).pipe(Effect.provide(NotificationQueue.layer))
```

## NotificationQueue

Journal-backed durable admission and turn-boundary drain. Import from
`@smthrs/notifications/NotificationQueue`.

### Service

```ts
interface Service {
  readonly admit: (
    runId: string,
    notification: Notification.Notification,
    version?: number
  ) => Effect.Effect<AdmissionReceipt, Journal.JournalError | NotificationError>
  readonly drain: (
    input: DrainInput
  ) => Effect.Effect<DrainReceipt, Journal.JournalError | NotificationError>
  readonly pending: (
    runId: string
  ) => Effect.Effect<ReadonlyArray<Notification.Notification>, Journal.JournalError | NotificationError>
}
```

| Method                       | What it does                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `admit(runId, notification)` | Decodes the notification, snapshots it, and records one admission decision for `runId`. Idempotent on `notification.id`.     |
| `drain(input)`               | Promotes what the boundary named by `input` may deliver, and records the promotion. First writer wins on the drain identity. |
| `pending(runId)`             | Returns the run's admitted but unpromoted notifications, in admission order, across every lineage.                           |

`NotificationQueue` is the service tag, a `Context.Service` under the key
`/notifications/NotificationQueue`.

New admissions persist a SHA-256 fingerprint of the validated notification's
canonical JSON before journal redaction. Identical retries return the committed
receipt even when redaction changed the stored payload. Different content still
fails with `notification_id_reused`, including changes to redacted fields.
Legacy admissions without a fingerprint compare against their persisted content;
original values removed by redaction cannot be recovered.

Redaction applies to the whole record, not only the payload. A versioned edit
therefore compares a second fingerprint, of the notification with its payload
cleared, so an attribution value the journal hides still pins the owner and
delivery binding. Rows without that fingerprint compare their persisted
envelope. After writing an admission, the queue reads the row back inside the
same transaction. If the journal rewrote `id`, `targetLineageId`, or
`coalescingKey`, no drain or coalescing match could address the row, so
admission fails with `notification_invalid`, `path` names that field, and the
write rolls back.

The journal-backed layers deeply freeze decoded notifications, including nested
payload objects and arrays, before `pending` or `drain` exposes them. Outputs
carry the persisted, possibly redacted content. Consumer mutation cannot change
later reads or drain receipts.

`admit` and `drain` may run inside an enclosing `journal.transact` while
standalone queue calls are pending. Both acquire the journal transaction before
the queue permit. Shared folds are published only after the enclosing commit.

The fold reads only Admitted/Promoted event types through `Journal.entries` and
keeps the last matching canonical sequence as its cursor. Unrelated run events
do not require decoding or advance that cursor. A compaction floor that passes
the cursor causes a conservative `JournalError(compacted)` refusal, including
for a warm queue. Deployments that compact active notification histories need
a queue-aware retention or checkpoint policy; the current production
compositions do not enable compaction.

Admission refuses any value at depth 256, including a primitive leaf, with
`notification_invalid` and writes no row. The notification envelope is depth 0;
its payload is at depth 1, and depth 255 is the deepest legal value. This leaves
one level for the journal's admission record under its redaction depth bound.
Cyclic payloads receive the same typed refusal. Payload objects must be plain
records (including records with a null prototype or from another JavaScript
realm) or arrays. Arrays are copied without subclass serialization hooks.
A `Date`, `Map`, `Set`, typed array or other class instance is refused at
`path: "payload"` rather
than acknowledged with its content lost.

The journal-backed queue validates identifiers before reading or writing.
`runId`, `id`, `targetLineageId` and a drain's `boundary` must be non-empty,
well-formed UTF-16 without NUL. A journal identifier is at most 1,024 code units:
an `id` must fit with `/notifications/admission/`; a lineage and boundary must
fit together, percent-encoded, with `/notifications/drain/` and their separator.
Admission reserves room for at least one encoded code unit of a nonempty
boundary, so every admitted lineage has an addressable drain.
Invalid identifiers fail with `notification_invalid`; `path` names
`runId`, `id`, `targetLineageId` or `boundary`. When a lineage and boundary
only exceed the bound together, the refusal has no single-field `path`.
Non-ASCII text and paired surrogates remain legal within these bounds.

Admission also refuses a notification larger than 1,048,576 UTF-16 code units
with `notification_invalid` and writes no row. Every string and object key
counts at its length and every other value counts as one. The bound is checked
before the notification is copied, decoded, or fingerprinted.

### AdmissionReceipt

```ts
interface AdmissionReceipt {
  readonly notificationId: string
  readonly decision: NotificationState.AdmissionDecision
  readonly seq: number | undefined
  readonly duplicate: boolean
  readonly consumed?: boolean
  readonly consumedNotification?: Notification.Notification
}
```

| Field                  | Meaning                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notificationId`       | The `id` of the notification this receipt answers for.                                                                                                                          |
| `decision`             | `admitted`, `coalesced`, or `rejected-full`. A caller MUST read it: `rejected-full` means the queue retained nothing.                                                           |
| `seq`                  | The journal sequence the admission committed at. Absent exactly when nothing was written, which today means `rejected-full`.                                                    |
| `duplicate`            | The id had already been admitted. `decision` and `seq` are read back from the committed record rather than recomputed.                                                          |
| `consumed`             | `true` when a newer version tries to edit a previously admitted notification that is no longer pending, after promotion or replacement by coalescing. The edit is not admitted. |
| `consumedNotification` | The persisted, possibly redacted prior notification, returned with `consumed: true`.                                                                                            |

### DrainInput

```ts
interface DrainInput {
  readonly runId: string
  readonly targetLineageId: string
  readonly boundary: string
  readonly wouldIdle: boolean
  readonly cutoffSeq?: number | undefined
  readonly ids?: ReadonlyArray<string> | undefined
}
```

| Field             | Meaning                                                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`           | The run whose journal holds the notifications.                                                                                                                                                                                                                                                       |
| `targetLineageId` | The lineage this boundary belongs to. Notifications for other lineages are left pending.                                                                                                                                                                                                             |
| `boundary`        | The name of this safe point. With `runId` and `targetLineageId` it is the drain identity.                                                                                                                                                                                                            |
| `wouldIdle`       | Whether the run would have nothing to do if this boundary delivered nothing. When true and no steer was promoted, one queued notification is promoted.                                                                                                                                               |
| `cutoffSeq`       | The journal sequence that opened this turn. Steers admitted after it are held for the next boundary. Omitting it delivers everything pending for the lineage. A value that is not a non-negative integer fails with `notification_invalid`.                                                          |
| `ids`             | The pending steers this boundary delivers, by id, for a consumer that confirms each one it took, such as an agent outside the run that answered after each. Ids not pending for the lineage are ignored; nothing else is promoted, queued notifications included. It takes the place of `cutoffSeq`. |

### DrainReceipt

```ts
interface DrainReceipt {
  readonly notifications: ReadonlyArray<Notification.Notification>
  readonly boundary: string
  readonly duplicate: boolean
}
```

`notifications` are the ones the committed promotion record names, so two
processes draining one boundary report the same delivery. `duplicate` is true
when the boundary had already drained.

### NotificationError

```ts
class NotificationError extends Schema.TaggedError<NotificationError>()(
  "/notifications/NotificationError",
  {
    code: "notification_unavailable" | "notification_closed" | "notification_full" | "notification_id_reused" | "notification_invalid" | "notification_refused"
    message: string
    notificationId?: string
    path?: string
  }
) {}
```

| Field            | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `code`           | The stable half, and the one to branch on. Defaults to `notification_unavailable`. |
| `message`        | Human-readable detail. Never carries the offending value.                          |
| `notificationId` | The notification the failure is about, when one was readable.                      |
| `path`           | Dotted path of the offending field, for `notification_invalid`.                    |

| Code                       | Means                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification_unavailable` | The seam serves nothing, or the journal identity for a drain holds an event this queue did not write.                                                                    |
| `notification_closed`      | New public refusal code: this receiver has finished. Start a new request; retrying this message at the closed receiver cannot deliver it.                                |
| `notification_full`        | New public refusal code: nothing was retained. Retry the same notification after pending work drains.                                                                    |
| `notification_id_reused`   | A stable id was already admitted with different content. A producer bug, not a storage failure.                                                                          |
| `notification_invalid`     | The value or an identifier is invalid, the journal redacts an address field, or a drain's `cutoffSeq` is not a non-negative integer. `path` names the field that failed. |
| `notification_refused`     | A reserved `outside_change` payload was refused before admission.                                                                                                        |

Storage failures surface as `Journal.JournalError` instead, so the two stay
distinguishable.

The queue's ordinary `admit` still returns its existing `rejected-full` receipt.
`Control.steer` and configured receivers expose that refusal as
`NotificationError(notification_full)` instead of acknowledging an undeliverable
message. Configured receiver policies can also emit `notification_closed`.
Existing notification error fields and older codes are unchanged. Consumers
with an exhaustive code union must include `notification_closed`,
`notification_full` and `notification_refused`. The Control RPC error
union now carries this existing error class; update remote decoders together
with the server so they can decode these refusals.

### Constructors and layers

| Export      | Signature                                                                               | What it provides                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `make`      | `(implementation: Service) => Service`                                                  | The service, from an implementation of its three methods.                                                           |
| `makeNoop`  | `(overrides?: Partial<Service>) => Service`                                             | A service whose every method fails with `notification_unavailable`, except the ones `overrides` replaces.           |
| `layerNoop` | `(overrides?: Partial<Service>) => Layer<NotificationQueue>`                            | `makeNoop`, as a layer. Requires nothing.                                                                           |
| `layerWith` | `(options?: { capacity?: number }) => Layer<NotificationQueue, never, Journal.Journal>` | The journal-backed implementation at the given pending capacity, defaulting to `NotificationState.defaultCapacity`. |
| `layer`     | `Layer<NotificationQueue, never, Journal.Journal>`                                      | `layerWith()`: the journal-backed implementation at the default capacity.                                           |

Both journal-backed layers write through the journal's unfenced durable channel,
so `admit` and `drain` return only after the corresponding entry is committed.
The channel is unfenced on purpose: the notifying process owns no run, so there
is no ownership fence to hand over, and both records are first-writer-wins on
their own identity instead.

## Notification

The durable notification payloads and their admission classification. Import
from `@smthrs/notifications/Notification`.

### Schemas

| Export          | Shape                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Provenance`    | `{ sourceRunId: string; sourceLineageId: string; sourceTurn: number; sourceActor: string; attribution?: Readonly<Record<string, string>> }`. `sourceTurn` is an integer at or above zero. |
| `HumanSteer`    | Tagged `"human-steer"`. The common fields plus `delivery: "steer"`.                                                                                                                       |
| `HumanFollowup` | Tagged `"human-followup"`. The common fields plus `delivery: "queue"`.                                                                                                                    |
| `SystemEvent`   | Tagged `"system-event"`. The common fields plus `delivery: "queue"` and an optional `coalescingKey: string`.                                                                              |
| `Notification`  | The union of the three.                                                                                                                                                                   |

The common fields on every member are `id` (a non-empty string, and the caller's
idempotency key), `targetLineageId` (a non-empty string), `provenance`, and
`payload` (any JSON value).

Provenance travels with the notification because the run that receives one is
not the run that wrote it. An operator steer, a parent run's event, and a webhook
all arrive on the same queue, and only these fields say which is which after the
fact. Optional `attribution` carries producer-supplied labels alongside the
authenticated `sourceActor`. These labels do not authorize a notification or a
model action and pass through the journal's ordinary redaction policy.

### Functions

| Export           | Signature                                            | Returns                                                                                                                                          |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admissionClass` | `(notification: Notification) => "steer" \| "queue"` | How the notification is allowed to reach the model. Steers are promoted in a batch at turn close; queued notifications one at a time at idle.    |
| `coalesceKey`    | `(notification: Notification) => string \| null`     | The key the notification coalesces on, or `null` when it must never coalesce. Only a `system-event` that declares a `coalescingKey` returns one. |

### humanSteer

```ts
const humanSteer: (input: {
  readonly runId: string
  readonly id: string
  readonly actor: string
  readonly payload: Schema.Json
  readonly attribution?: Readonly<Record<string, string>>
}) => HumanSteer
```

A person's steer to a run's own lineage: `targetLineageId`, `sourceRunId` and
`sourceLineageId` are `runId`, `sourceTurn` is `0`, and `sourceActor` is
`actor`. `id` is the caller's idempotency key. `Control.steer` builds its steer
here, and so does any host that admits a person's message straight into a
run's queue, so a steer reads the same in every transcript.

```ts
yield * queue.admit(
  runId,
  Notification.humanSteer({
    runId,
    id: messageId,
    actor: `person:${login}`,
    attribution: { login },
    payload: SteerPayload.encode({ kind: "Message", body })
  })
)
```

## NotificationState

The pure bounded queue: the same rules with no I/O and no journal. Import from
`@smthrs/notifications/NotificationState`.

### Models

| Export              | Shape                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `defaultCapacity`   | `128`. The default maximum pending notifications per run.                                                |
| `Pending`           | `{ notification: Notification; seq: number }`. `seq` is the journal sequence the admission committed at. |
| `State`             | `{ capacity: number; items: ReadonlyArray<Pending> }`. Frozen, and every transition returns a new value. |
| `Admission`         | `{ state: State; decision: AdmissionDecision }`.                                                         |
| `Promotion`         | `{ state: State; promoted: ReadonlyArray<Pending> }`.                                                    |
| `AdmissionDecision` | Re-exported from `NotificationEvent`, which owns the single declaration.                                 |

### Operations

| Export           | Signature                                                                                           | What it does                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty`          | `(capacity: number) => State`                                                                       | An empty queue. A capacity that is not a finite number becomes zero, so a misconfigured bound refuses everything rather than retaining an unbounded backlog.                                   |
| `admit`          | `(state: State, notification: Notification, seq: number) => Admission`                              | Admits, coalescing only pending system events with the same key, and keeping the first sequence so replay order stays stable. A queue at capacity decides `rejected-full` and retains nothing. |
| `applyAdmission` | `(state: State, notification: Notification, seq: number, decision: AdmissionDecision) => State`     | Applies a decision already committed in a journal record. Replay never re-decides.                                                                                                             |
| `pending`        | `(state: State, admission: "steer" \| "queue", targetLineageId?: string) => ReadonlyArray<Pending>` | Still-pending notifications of one admission class, in durable journal order, for one lineage or for every lineage.                                                                            |
| `promoteSteers`  | `(state: State, cutoffSeq: number, targetLineageId?: string) => Promotion`                          | Promotes every steer admitted at or before the cutoff. Notifications admitted after it remain pending.                                                                                         |
| `promoteIds`     | `(state: State, ids: ReadonlyArray<string>, targetLineageId?: string) => Promotion`                 | Promotes the pending steers named in `ids`, in admission order, whatever their sequences, and a named legacy `outside_change` system event. Ids not pending for the lineage are ignored.       |
| `promoteQueued`  | `(state: State, targetLineageId?: string) => Promotion`                                             | Promotes exactly the oldest pending queued notification, or nothing.                                                                                                                           |
| `applyPromoted`  | `(state: State, ids: ReadonlyArray<string>) => State`                                               | Removes the ids a durable promotion record names, while replaying history.                                                                                                                     |

## NotificationEvent

The journal event types this package owns. Import from
`@smthrs/notifications/NotificationEvent`.

| Export              | Value or shape                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AdmittedEventType` | `"flows/notifications/Admitted"`. Frozen: the value is already durable in every journal this package has written to.                 |
| `PromotedEventType` | `"flows/notifications/Promoted"`. Frozen for the same reason.                                                                        |
| `AdmissionDecision` | `"admitted" \| "coalesced" \| "rejected-full"`. The one declaration of the admission vocabulary.                                     |
| `Admitted`          | `{ notification: Notification; decision: AdmissionDecision; fingerprint?: string; identityFingerprint?: string; version?: number }`. |
| `Promoted`          | `{ boundary: string; targetLineageId: string; ids: ReadonlyArray<string> }`.                                                         |
| `Event`             | `Admitted \| Promoted`.                                                                                                              |
| `admissionSourceId` | `(notificationId: string) => JournalEvent.SourceId`. The source every admission of one notification is written under.                |
| `drainKey`          | `(targetLineageId: string, boundary: string) => string`. One drain's identity, each component percent-encoded.                       |
| `drainSourceId`     | `(targetLineageId: string, boundary: string) => JournalEvent.SourceId`. The source one drain's record is written under.              |

The throwing identifier constructors remain available for trusted input.
`admissionSource(notificationId)` returns `Option<JournalEvent.SourceId>`
instead, with `None` for an invalid prefixed identifier.
`drainSource(targetLineageId, boundary)` does the same for the combined,
percent-encoded drain identity, including malformed UTF-16.

A `rejected-full` decision is never written. The queue refuses a full queue in
the receipt alone, so the notification id stays admissible once a boundary
drains. The literal remains in `AdmissionDecision` because a reader must stay
total over a record any writer could have produced.

| Export       | Signature                                             | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAdmitted` | `(event: Event) => event is Admitted`                 | Whether the owned event is an admission record.                                                                                                                                                                                                                                                                                                                                                                                                |
| `isPromoted` | `(event: Event) => event is Promoted`                 | Whether the owned event is a promotion record.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fromEntry`  | `(entry: JournalEvent.Entry) => Option.Option<Event>` | The owned event a journal entry carries. Foreign entries and structurally invalid payloads answer `None`, so a projection over a shared journal stays total. An admission counts only under `admissionSourceId` of the notification it carries, and a promotion only under a `/notifications/drain/` source, so another producer's record with the same event type is ignored. The source scopes records; it does not authenticate the writer. |

## Projection

Import from `@smthrs/notifications/Projection`.

| Export   | Signature                                     | What it does                                                                                                            |
| -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `derive` | `Journal.Projection<NotificationState.State>` | Re-derives pending notifications from admitted and promoted journal entries. Foreign entries leave the state unchanged. |

The projection starts at `NotificationState.empty(NotificationState.defaultCapacity)`.
Capacity gates new admissions; it does not truncate replay. `applyAdmission`
applies the decision each record committed, so a composition built with
`NotificationQueue.layerWith` above the default replays every admission it
wrote. The projected `capacity` stays at the default because no journal record
carries the bound the layer was built at, so read `items` rather than
`capacity`.

A versioned edit of a steer that is still pending replaces that item in place
and keeps its original sequence, the same way the queue reads its own history,
so an edited steer projects as one pending item.

## SteerPayload

The steering vocabulary carried inside a notification payload. Import from
`@smthrs/notifications/SteerPayload`.

The vocabulary lives here rather than in either package that uses it: a control
plane admits a steer and a harness drains it, and neither may depend on the
other, so the shape they have to agree on belongs beneath both.

| Export            | Shape                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Thinking`        | `"none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"`. A subset of `ModelRequest.ReasoningEffort` in [`@smthrs/model`](/api/model), which also admits `"max"`; this package deliberately does not depend on it. |
| `MessagePayload`  | `{ kind: "Message"; body: string }`. The body may be empty.                                                                                                                                                               |
| `SeatPayload`     | `{ kind: "Seat"; seat: string }`. `seat` is non-empty.                                                                                                                                                                    |
| `ThinkingPayload` | `{ kind: "Thinking"; thinking: Thinking }`.                                                                                                                                                                               |
| `ToolsPayload`    | `{ kind: "Tools"; toolNames: ReadonlyArray<string> }`. Non-empty, of non-empty strings. Additive only: steering can widen the active tool set and cannot narrow it.                                                       |
| `SteerPayload`    | The union of the four.                                                                                                                                                                                                    |

| Export   | Signature                                                   | Returns                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decode` | `(notification: Notification) => SteerPayload \| undefined` | The steering item a notification carries, or `undefined` when it carries none. A `system-event` is never a steer. Inside a human notification, a record with a `body` string and no `kind` reads as a message. |
| `encode` | `(item: SteerPayload) => SteerPayload`                      | The record the item is stored as. Every item is written with its `kind`, including a message. The result is assignable to `Notification.payload` and shares no mutable structure with `item`.                  |

## Inbox

Pure routing and acknowledgement rules for per-person notices about runs.
Import from `@smthrs/notifications/Inbox`. See
[Who hears about a run](./concepts/inbox.md).

### Models

| Export          | Shape                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Level`         | `Schema`: `"all" \| "attention" \| "muted"`. How closely a principal follows a subject.                                                                                                             |
| `DEFAULT_LEVEL` | `"attention"`. The level of a watch nobody chose a level for.                                                                                                                                       |
| `RunState`      | `Schema`: `"working" \| "waiting" \| "needs_you" \| "failed" \| "done"`. A run's state as a notice reads it.                                                                                        |
| `Act`           | `Schema`: `"read" \| "dismiss" \| "hide"`. Read records that the person opened the notice, Dismiss closes it, Hide removes its toast and keeps its entry.                                           |
| `Watcher`       | `{ principal: string; level: Level }`. One principal following a subject.                                                                                                                           |
| `Delivery`      | `{ recipient: string; mine: boolean; state: RunState; quiet: boolean }`. One person's notice about a run. `quiet` means a toast while it lives and never a list entry.                              |
| `RunFact`       | `{ launcher: string \| undefined; state: RunState; watchers: ReadonlyArray<Watcher>; mayRead?: (principal: string) => boolean }`. What `route` reads about one run. `mayRead` defaults to everyone. |
| `Versions`      | `{ version: number; readVersion: number; dismissedVersion: number; hiddenVersion: number }`. A notice's versions.                                                                                   |

### Routing

| Export     | Signature                                                                                               | Returns                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route`    | `(fact: RunFact) => ReadonlyArray<Delivery>`                                                            | The launcher first, when defined and allowed by `mayRead` to read the run, with the run's own state, `mine: true` and `quiet: false`, even if the launcher's watch is muted. Then every other watcher that is not muted and may read the run, in input order, with `mine: false`; `needs_you` reads as `waiting`, and an `attention` watcher is `quiet`. Each recipient once; a principal listed twice is decided by its first entry. |
| `audience` | `(watchers: ReadonlyArray<Watcher>, mayRead?: (principal: string) => boolean) => ReadonlyArray<string>` | Who hears about a subject's event that is not a run, such as `main` moving or a new release: every watcher that is not muted and may read it, each once, in input order, decided by its first entry.                                                                                                                                                                                                                                  |

### Versions

| Export     | Signature                                                              | Returns                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raises`   | `(before: RunState \| undefined, after: RunState) => boolean`          | Whether the notice needs attention again, so its version goes up. True for a new notice, and when `after` is `needs_you`, `failed` or `done` and differs from `before`. False otherwise.                                                             |
| `ack`      | `<V extends Versions>(notice: V, act: Act, version: number) => V`      | The notice with the act's field set to `max(current, min(version, notice.version))`, the merge of Postgres' `greatest()`. Other fields are kept. A call that changes nothing, including a `NaN` version, returns `notice` itself. Order-independent. |
| `isOpen`   | `(notice: Pick<Versions, "version" \| "dismissedVersion">) => boolean` | `dismissedVersion < version`.                                                                                                                                                                                                                        |
| `isUnread` | `(notice: Pick<Versions, "version" \| "readVersion">) => boolean`      | `readVersion < version`.                                                                                                                                                                                                                             |
| `isHidden` | `(notice: Pick<Versions, "version" \| "hiddenVersion">) => boolean`    | `hiddenVersion >= version`.                                                                                                                                                                                                                          |

Each predicate reads only the two fields it compares, so any row carrying them
can be passed.

## Channels

One short message sent to people outside the app, by email (Resend) or
Telegram (the Bot API), with every failure classified for a flow engine's
retry. Import from `@smthrs/notifications/Channels`.

### Models

| Export           | Shape                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Channel`        | `"email" \| "telegram"`.                                                                                                                                                                                                                                                                                 |
| `Destination`    | `{ _tag: "email"; to: NonEmptyArray<EmailAddress> }` (at most `maxEmailRecipients`, 50) or `{ _tag: "telegram"; chatId: TelegramChatId }`.                                                                                                                                                               |
| `Message`        | `{ id; subject; text }`. `id` is the idempotency key, 1 to 256 printable ASCII characters, the same on every attempt; `subject` 1 to 200 characters; `text` 1 to 3,500, so a Telegram message fits.                                                                                                      |
| `Receipt`        | `{ channel: Channel; providerId: string \| null }`: Resend's email id, or Telegram's `message_id` as a string. The schema retains `null` for compatibility; the built-in layer returns a string id or fails with `unavailable` and `reason: "invalid_response"` when valid delivery evidence is missing. |
| `EmailAddress`   | A string `isEmailAddress` accepts.                                                                                                                                                                                                                                                                       |
| `TelegramChatId` | A string `isTelegramChatId` accepts.                                                                                                                                                                                                                                                                     |

| Export             | Signature                    | Returns                                                                                                               |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `isEmailAddress`   | `(value: string) => boolean` | One `@`, a dot in the domain, no spaces, angle brackets, commas or other separators, at most 254 characters.          |
| `isTelegramChatId` | `(value: string) => boolean` | A chat's number, such as `123456789` or a supergroup's `-1001234567890`, or a public channel's `@username` (5 to 32). |

### Failures

| Export            | Shape                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeliveryFailed`  | Tagged `@smthrs/notifications/DeliveryFailed`: `{ channel; code: FailedCode; status?; reason?; retryAfterMillis? }`. Another attempt may clear it: let the engine retry.                                                                      |
| `DeliveryRefused` | Tagged `@smthrs/notifications/DeliveryRefused`: `{ channel; code: RefusedCode; status?; reason? }`. Another attempt would be refused too: record it and stop.                                                                                 |
| `DeliveryError`   | The union of both, as a schema a flow step declares.                                                                                                                                                                                          |
| `FailedCode`      | `"unreachable"` (no answer: the transport failed), `"timeout"` (no whole answer within the bound), `"unavailable"` (5xx, 408, 409 or a 2xx without valid delivery evidence), `"rate_limited"` (429).                                          |
| `RefusedCode`     | `"rejected"` (a 3xx, which is never followed, or another 4xx; or a destination or message outside its schema, `reason: "invalid_message"`), `"unauthorized"` (401 or 403), `"unconfigured"` (the deployment has no provider for the channel). |

`reason` retains only known provider diagnostics: Resend's `name` values
`validation_error`, `rate_limit_exceeded` and `daily_quota_exceeded`, or the
Bot API's `description` `Bad Request: chat not found`. Any other non-empty
provider string becomes `provider_rejected`; an absent, empty or non-string
diagnostic is omitted. The layer also uses `invalid_response` when a 2xx
response lacks valid delivery evidence, and `invalid_message` for an invalid
destination or message. The schema bounds `reason` to 120 characters.
`retryAfterMillis` is the wait a
429 named, from the `Retry-After` header in whole seconds or the Bot API's
`parameters.retry_after`; it is an own property, which `@smthrs/flow`'s retry
decision uses in place of the policy's backoff, and it survives the journal.
A provider wait whose milliseconds are not a safe integer is ignored, leaving
the flow's retry policy to choose its backoff.
An unknown or absent destination tag is refused before any request, with
`reason: "invalid_message"`. Its refusal uses `channel: "email"` as the fixed
fallback; a recognized `"telegram"` tag keeps that channel even when its
destination is invalid. No fallback sends a message.
Neither failure holds the request, its url, a header or the destination.

### Service and layer

| Export             | Signature                                                                                                      | What it is                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChannelsService`  | `{ available: ReadonlyArray<Channel>; send: (destination, message) => Effect.Effect<Receipt, DeliveryError> }` | `available` lists the channels with a provider. `send` makes one request; a destination or message outside its schema is refused `rejected`, then a channel with no provider `unconfigured`, before any request.                                                                                                                                                     |
| `Channels`         | `Context.Service` under `@smthrs/notifications/Channels`                                                       | The service tag.                                                                                                                                                                                                                                                                                                                                                     |
| `layer`            | `(options: Options) => Layer<Channels>`                                                                        | Email through Resend when `options.email` is set, Telegram through the Bot API when `options.telegram` is. It owns its Fetch transport, keeps the host's `FetchHttpClient.RequestInit` but forces `redirect: "manual"`, and bounds each send by `options.timeout`. A provider url that isn't absolute `http:` or `https:` fails the layer as a defect naming no url. |
| `Options`          | `{ email?: EmailProvider; telegram?: TelegramProvider; timeout?: Duration.Duration }`                          |                                                                                                                                                                                                                                                                                                                                                                      |
| `EmailProvider`    | `{ apiKey: Redacted<string>; from: string; url?: string }`                                                     | A Resend API key, the sender (`Name <address>` on a domain Resend verified, or `onboarding@resend.dev` to reach only the account's own address), and Resend's origin.                                                                                                                                                                                                |
| `TelegramProvider` | `{ token: Redacted<string>; url?: string }`                                                                    | A bot's token from @BotFather, and the Bot API's origin.                                                                                                                                                                                                                                                                                                             |

| Export               | Value                         |
| -------------------- | ----------------------------- |
| `defaultEmailUrl`    | `"https://api.resend.com"`.   |
| `defaultTelegramUrl` | `"https://api.telegram.org"`. |
| `defaultTimeout`     | Ten seconds.                  |
| `maxEmailRecipients` | `50`, Resend's own limit.     |

Email is `POST <url>/emails` with `Authorization: Bearer <apiKey>`,
`Idempotency-Key: <message.id>` and `{ from, to, subject, text }`: Resend sends
one email per key within 24 hours. Telegram is `POST <url>/bot<token>/sendMessage`
with `{ chat_id, text: "<subject>\n\n<text>", link_preview_options: { is_disabled: true } }`,
as plain text. The Bot API has no idempotency key, so a process that dies between
Telegram's answer and its own record of it sends twice.

Each send is one span, `notifications.channel.send`, with `smithers.channel`,
`http.response.status_code`, `smithers.channel.outcome` (`sent`, `failed` or
`refused`) and `smithers.channel.code`. The HTTP client's own span, which records
the url (and so the bot token), is off for these requests, and no trace context
is sent to the provider.

## Alerts

Run conditions that have lasted too long, turned into durable, coalesced,
delivered-once notifications. Import from `@smthrs/notifications/Alerts`.

### Policy

| Export             | Shape                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Severity`         | `"info" \| "warning" \| "critical"`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `Detector`         | `{ field: string; value: string; eventTypes?: ReadonlyArray<string>; summary?: string }`. `field` names a payload key, `value` the value that means the condition holds, and `eventTypes` narrows which entries are consulted; an item ending in `.*`, such as `control.*`, names every event type with that prefix. `summary` names a payload key whose string, on the entry that opened the condition, rides on the alert. |
| `Rule`             | `{ afterMs: number; repeatMs?: number; severity?: Severity; owner?: string; runbook?: string }`. `afterMs` is a whole, non-negative number of milliseconds. `repeatMs` is a whole, positive number of milliseconds: the alert pages again every period while the condition stays open and unacknowledged.                                                                                                                    |
| `Policy`           | `{ defaults?: { severity?; owner?; runbook? }; rules: Record<string, Rule>; detectors?: Record<string, Detector> }`.                                                                                                                                                                                                                                                                                                         |
| `defaultDetectors` | `Readonly<Record<string, Detector>>`: `waiting-approval` and `failed` on `status`, `stalled` on `health`, `quota-parked` on `waitingReason`, each consulting only the `control.*` event types.                                                                                                                                                                                                                               |

An entry that carries a detector's field with the matching value opens the
condition; an entry that carries it with any other value closes it. A policy's
own `detectors` are merged over `defaultDetectors`.

### Decisions

| Export  | Shape                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Open`  | `{ runId: string; condition: string; since: number; summary?: string }`. `since` is the journal time of the entry that opened the condition, and `summary` what that entry said.                                                                                                      |
| `Alert` | `{ runId; condition; since; firedAt; reminder?; severity; coalescingKey; summary?; owner?; runbook? }`. `firedAt` is `since + afterMs`, never the wall clock of whichever tick noticed. On a repeat, `reminder` counts the periods and `firedAt` is the instant that repeat came due. |

| Export          | Signature                                                                                            | Returns                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conditions`    | `(policy: Policy, runId: string, entries: ReadonlyArray<JournalEvent.Entry>) => ReadonlyArray<Open>` | Every condition a run's journal leaves open, with the time each opened. `entries` are oldest first.                                                                                                      |
| `decide`        | `(policy: Policy, open: ReadonlyArray<Open>, now: number) => ReadonlyArray<Alert>`                   | The alerts the policy raises for the conditions open at `now`. Pure: `now` decides whether an alert is raised and never appears in one.                                                                  |
| `coalescingKey` | `(runId: string, condition: string) => string`                                                       | The key an alert coalesces on: one open condition on one run. Each component is percent-encoded, so neither can forge another pair's key.                                                                |
| `alertId`       | `(alert: Pick<Alert, "coalescingKey" \| "since" \| "reminder">) => string`                           | `alert:<coalescingKey>:<since>`, with `:r<n>` appended on a repeat. The identity a delivery is recorded under, stable for the life of one condition. A condition that clears and re-opens gets a new id. |

### Sinks

| Export                  | Signature                                                                                                  | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SinkService`           | `{ deliver: (alert: Alert) => Effect.Effect<void, AlertError> }`                                           | Where a raised alert is sent. `deliver` MUST be idempotent on `alertId(alert)`, and MUST fail when the page did not go out.                                                                                                                                                                                                                                                                                                                                                                          |
| `Sink`                  | `Context.Service` under `/notifications/AlertSink`                                                         | The service tag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `layerNoop`             | `Layer<Sink>`                                                                                              | Accepts every alert and sends it nowhere. The admission and the delivery record still happen.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `layerChannels`         | `(options: { destination: Channels.Destination }) => Layer<Sink, never, Channels.Channels>`                | Sends each alert as one message through `Channels`, to a Telegram chat or by email. The message id is the alert's id, or its digest when the id is longer than 256 characters. Every channel failure fails the delivery: `unreachable` is `sink_unreachable`, `timeout` is `sink_timeout`, and every other code is `sink_rejected` with the channel's reason.                                                                                                                                        |
| `messageOf`             | `(alert: Alert) => Channels.Message`                                                                       | The message `layerChannels` sends: the severity and condition as the subject, then the summary, run, opening time, owner, runbook and the id to acknowledge the alert by.                                                                                                                                                                                                                                                                                                                            |
| `defaultWebhookTimeout` | `Duration.Duration`                                                                                        | Ten seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `layerWebhook`          | `(options: { url: string; headers?: Record<string, string>; timeout?: Duration.Duration }) => Layer<Sink>` | POSTs each alert to one webhook using an owned Fetch client with redirects disabled and a scope per delivery. Injected `HttpClient` layers are not used. The body is the alert plus its `alertId`, and the same id is sent as an `Idempotency-Key` header, set after the caller's headers. A non-2xx answer is a failure; an endpoint that never answers fails after `timeout`. The delivery's HTTP span records the method, scheme, host, port and status, never the url's path, query or userinfo. |

| Export        | Shape                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `FailureCode` | `"sink_rejected" \| "sink_unreachable" \| "sink_timeout" \| "sink_misconfigured"`.                              |
| `AlertError`  | Tagged `/notifications/AlertError`: `{ code: FailureCode; message: string; status?: number; reason?: string }`. |

`sink_misconfigured` is the one code no alert ever carries. `layerWebhook`
validates its `url` while the layer is built, before any alert exists, and a url
that is not an absolute `http:` or `https:` one dies there rather than failing
through the delivery channel: a scheme bound is what keeps a credential set in
`headers` from being handed to something that is not HTTP.

`AlertError` deliberately holds no request. A webhook request carries the
credential the deployment handed `layerWebhook`, and an error is logged, encoded,
and journaled in places a credential must never reach.

### Probes

| Export           | Signature                                                                       | What it does                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ProbeState`     | `"failing" \| "ok"`                                                             | What a probe saw.                                                                                                                        |
| `Report`         | `{ runId: string; probe: string; state: ProbeState; summary?: string }`         | One probe result. `runId` is the run that owns the problem. `runId` and `probe` are non-empty.                                           |
| `report`         | `(input: Report) => Effect.Effect<void, Journal.JournalError, Journal.Journal>` | Journals one probe result into the owning run. Reporting the same state again changes nothing. An empty `runId` or `probe` dies.         |
| `probes`         | `(rules: Record<string, Rule>) => Pick<Policy, "rules" \| "detectors">`         | The rules and detectors for a set of probes, keyed by probe name. Spread it into a policy.                                               |
| `probeDetector`  | `(probe: string) => Detector`                                                   | The detector that reads one probe's reports.                                                                                             |
| `probeEventType` | `(probe: string) => string`                                                     | `flows.alerts.probe.<name>`, with the name percent-encoded and `*` encoded too, so a probe's name is never read as an event-type family. |

### Runtime

| Export           | Shape                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Tick`           | `{ delivered; failed; refused; suppressed }`, each a `ReadonlyArray<Alert>`.                                                                                                                                                                                                                                                                                                                           |
| `Standing`       | `{ alertId: string; alert: Alert; state: "raised" \| "delivered" \| "acknowledged"; acknowledgedBy?: string }`. One open alert and what has happened to it. `alertId` has no repeat ending.                                                                                                                                                                                                            |
| `RuntimeService` | `{ tick: (runId: string) => Effect.Effect<Tick, Journal.JournalError \| NotificationError>; acknowledge: (runId: string, alertId: string, by: string) => Effect.Effect<boolean, Journal.JournalError>; standing: (runId: string) => Effect.Effect<ReadonlyArray<Standing>, Journal.JournalError> }`. `acknowledge` answers `false` and writes nothing when the run has no open condition with that id. |
| `AlertRuntime`   | `Context.Service` under `/notifications/AlertRuntime`. The service tag.                                                                                                                                                                                                                                                                                                                                |

| Field of `Tick` | Meaning                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `delivered`     | Raised and accepted by the sink on this tick.                                                           |
| `failed`        | The sink refused them. Retried on the next tick.                                                        |
| `refused`       | The notification queue was at capacity. The sink was not called, and they are retried on the next tick. |
| `suppressed`    | This page was already delivered, or the alert is acknowledged. Not delivered again.                     |

| Export  | Signature                                                                                      | What it provides                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer` | `(policy: Policy) => Layer<AlertRuntime, never, Journal.Journal \| NotificationQueue \| Sink>` | The alert runtime over one policy. The policy is decoded when the layer is built, so a rule with an impossible delay fails the composition by name. |

| Export                  | Value                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `deliveredEventType`    | `"flows.alerts.delivered"`. One entry per delivered alert.                                                             |
| `failedEventType`       | `"flows.alerts.failed"`. One entry per alert per failure code, never one per tick.                                     |
| `acknowledgedEventType` | `"flows.alerts.acknowledged"`. One entry per acknowledged alert, under `/notifications/alerts/<alertId>/acknowledged`. |
| `maxSummaryLength`      | `500`. The most characters of a summary an alert carries.                                                              |

A tick admits the alert, sends it, then journals the delivery. Admission is
idempotent and the send is not, so a crash between the first two costs a
duplicate admission the queue drops, while a crash between an accepted send and
the delivery record costs a duplicate page. That is why `deliver` is required to
deduplicate on `alertId`.

All three owned event types are excluded from condition detection: they are written
into the journal the detectors read, and they carry the alert's own vocabulary,
so reading them as evidence would let a page close the condition it paged about.

A `flows.alerts.delivered` entry suppresses a page only under the source the
alerter writes, `/notifications/alerts/<alertId>/delivered`. The same entry under
any other source is ignored. The journal does not bind a source to a writer, so
this keeps other producers' records out; it does not authenticate the writer.

See [`@smthrs/control`](/api/control) for the run conditions the entries come
from.

Versioned human steers use a positive safe integer. A higher version replaces the
pending payload at its original position, with the same owner and delivery
binding. Promotion consumes the input: a later version returns `consumed: true`
with the consumed notification, without writing or changing the delivered payload. Older versions are no-ops;
reusing a version with different content refuses. Replacement and drain share
the journal transaction, including rollback and cross-process serialization.
