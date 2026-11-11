# Repository notification recipient policy

2026-11-05 · #4026 · rulings PLUGIN-1, DUR-1, FE-14, AUTH-8, ARCH-16

Repository-scoped run notices and repository main/release events now expose
`RecipientPolicy`, an Effect service in `worker/NotificationPolicy.ts`. Plugins
provide the service in the notification host's environment. `layerFlow(repoId,
flow)` binds one repository's declared flow using the host's registered durable
engine. Other repositories keep their existing default. This is the current
app's extension seam; the retired app's factory dispatcher is not restored.

The flow accepts `Request` and returns `Decision`. Input contains only repository,
subject, event kind, revision, optional launcher identity, candidate ids, and
default recipient ids. It never receives a title, question, body, URL, session,
credential, or secret value. The decision names at most 50 person ids and may
set `handling.quiet`. Unknown output fields, invalid ids, and more than 50
recipients are rejected. Duplicates are removed after validation. An empty
recipient list is an intentional decision, not a failure.

The default remains `@smthrs/notifications`'s `Inbox.route` for runs and
`Inbox.audience` for repository events. Candidates are the same eligible
launcher/watch audience; policy can narrow it but cannot subscribe an outsider
or override a mute. An absent service or an unselected repository keeps that
default. Failure or a defect records `policy-failed`; malformed output records
`policy-malformed`; a 10-second deadline or an audience too large for the policy
records `policy-unavailable`. A large default audience is preserved in full.
Caller cancellation propagates. Logs, spans, and the
`smithers_notification_policy_decisions` counter record only closed outcomes
and counts; no raw policy errors or returned fields enter diagnostics.

`layerFlow` uses `Flow.execute`, with a stable execution id derived from the
flow tag and identity-only request. Replay reattaches to the existing decision;
a changed event revision or candidate audience gets a new execution. The host
owns registration, credentials, and persistence. Policy waiting introduces no
queue, retry loop, secondary runtime, or database migration. A late decision
has no callback that can change the fallback's rows.

The core writer still owns authorization. Repository events acquire recipients'
feed locks after policy selection and reread watches, live sessions, deployment
roles, and recorded repository denials before writing. Run folding keeps its
ordered feed locks and rereads branch policy and repository denials after the
decision. Selected ids are intersected with that audience, so policy grants no
access. Existing run recipients who still have access continue to see their
rows settle, even if muted or omitted by a later policy. This preserves the
existing live-work lifecycle. Feed disclosure retains its independent current
access checks and revocation fences.

Versions, idempotent writes, and per-person read/dismiss/hide acknowledgments
remain in the existing notification writer. The new handling flag changes only
quiet presentation. The policy cannot acknowledge, approve, merge, or change
notification content.

Libraries used from `docs/libraries.md`: `@smthrs/flow` for durable execution,
`@smthrs/crypto` for stable execution identities, and `@smthrs/notifications` for
the existing audience defaults. The app owns this service because its principal
ids, feed locks, and authorization checks are application policy.

`worker/NotificationPolicy.test.ts` exercises the public flow adapter against
the real Smithers engine and the writer against an isolated Postgres schema.
Faulty Effect services supply invalid output, hangs, and access changes. The
suite checks fallback, strict output bounds, cancellation, replay, revocation,
muting, identity-only payloads, quiet handling, and per-person acknowledgments.

`.smithers/flows/notification-policy/flow.ts` is the policy a repository copies. It
restates `Request` and `Decision` because a copy cannot import the app; the suite
compares their JSON Schema documents with the app's and runs the flow through
`layerFlow` on the requests `worker/Notifications.ts` builds. The retired app's `@smthrs/rpc` contract is deleted.
