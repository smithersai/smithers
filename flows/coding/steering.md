# Coordinator-owned request feedback

`steering.ts` is private repository configuration over the existing notification
queue. It adds no public package API, table, event type, or message transport.
The gateway keeps its existing `Control.steer` operation and actor attribution.

The configured request host supplies a queue decorator to the private native
composition:

```ts
const native = NativeControl.make(platform, resolveSeats, routeMessages)
// Include feedbackLayer in the existing module registrations.
```

`NativeControl.make` has one new optional third argument. It forwards the same
private `NotificationDecorator` to `LocalControl.layer`'s optional fourth
argument: `(queue: NotificationQueue.Service, control: ControlRuntime.Service)
=> NotificationQueue.Service`. The default composition is unchanged. One
decorated queue instance is shared by ControlLive and the native executor, over
their existing control journal. Admission returns the original queue Effect in
the caller's fiber, retaining the enclosing control mutation's transaction.

For a root-addressed Message, the decorator reads the existing control run and
approved plan. Only an active `coding/request` run whose recorded digest and
`coding/RunRequest` delegate match receives the private coordinator lineage.
Lookup failures and invalid coding ownership refuse admission. Other flow roots,
explicit leaf addresses, Seat, Thinking and Tools retain their existing routes.
This is an all-Message coding policy: a provenance string is not proof that the
sender is a human. Cancellation and approvals keep their established paths.
The configured Message route also turns the queue's `rejected-full` decision
into an existing NotificationError, so Control cannot acknowledge feedback that
the queue did not retain. The caller can retry after a coordinator boundary.

`ModuleOwner` is new private invocation data containing `{rootId, flowId}`. It
is installed by ModuleAuthority only after the existing native ancestry,
approved executable and active-run checks succeed again for that handler,
including on resume. The action never accepts ownership from a payload or
infers it from a native child ID. No construction-time owner is invented.

The coordinator composes an ordinary durable action at its safe boundaries:

```ts
ReceiveFeedback.call({ boundary: "after-poc", revision: 0 })
ReceiveFeedback.call({ boundary: "before-implementation", revision: 1 })
ReceiveFeedback.call({ boundary: "after-correction", revision: 1 })
```

The result is `FeedbackReceipt {boundary: string, messages: Notification[]}`.
Its boundary is the JSON tuple of actual native execution ID, named boundary
and revision. The queue's existing durable promotion receipt makes repeated
reads, including after reopening SQLite, return the same message identities.
Messages arriving later remain pending for a newer boundary. Empty receipts are
durable too. Model turns cannot consume the coordinator lineage; they still
receive ordinary settings at their existing turn boundaries.

After the action result is recorded, `appendFeedback(previous, receipt)` returns
an Effect containing the combined planning feedback or a `CodingError`. It
retains each notification's ID, actor and source provenance. The receipt matches
the queue's default bound of 128 pending notifications. The queue itself has no
byte limit; Control applies its existing mutation-size admission bound. The
planner's existing 65,538-character feedback bound is checked without silent
truncation. An overflow refuses planning and names the retained IDs: admission,
promotion and native receipt remain inspectable in the existing journals.

Receiving feedback is not a plan revision. A following `PrepareWithWiki` child
must complete with an actual validated Plan before the UI can show a revised
plan. Feedback during implementation waits for the coordinator's next safe
linear mutation boundary; this helper does not preempt an executing atom or
claim to pause on every prototype. The request recipe owns those transitions.
There is no atomic closure spanning the final after-correction drain and control
completion. A message arriving in that interval can remain pending after the
request completes; its admission is not proof that a revised plan ran. A later
request can explicitly carry that retained feedback. This helper does not claim
to close that queue/engine race.

Validation covers real SQLite queue reopen, repeated and empty boundaries,
mixed Message/Seat/Thinking/Tools delivery, unrelated roots and leaf lineages,
lookup/digest/approval refusal, rollback inside the caller's transaction, an
actual Action execution requiring invocation ownership, capacity refusal and attributed overflow.
The native module host test also checks that each executed child receives its
actual approved root identity, including the source-drift refusal case.
