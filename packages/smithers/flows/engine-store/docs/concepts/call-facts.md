# Native call facts and their outbox

`flows.harness.call-fact.v1` is the versioned durable producer for agent cell
calls. It is separate from `AgentSession`'s best-effort trace consumer. The
immutable native journal is the outbox; there is no second delivery queue or
consumer-side writer that reconstructs a missing call from a flow name.

## Identity and authorization

The harness constructs the existing dispatch identity before invoking a call:
logical run, frame, cell digest, invocation ordinal, declaration digest, and
ordered active layers. Its stable `cell-call-v1:<sha256>` digest is unchanged.
The public fact calls the logical run coordinate `identity.runId`; it is not
an authentication session. Existing action keys and legacy trace producer IDs
are unchanged. The annotations are additive metadata, never key material.

`FlowEngineLike.call` authorizes before constructing the annotated native
action. Only then can its owner commit the `invoked` fact. Permission refusal
or a parked approval does not claim a native invocation. Legacy trace telemetry
may describe that attempted call, and the separate approval stream describes
the durable request.

## Commit and delivery

Fresh attempt admission, its existing lifecycle records, and the invocation
fact share one fenced native transaction. Failure rolls admission back and
prevents the handler, sandbox, and result publication. A verified cache replay
commits invocation before materializing outputs. An older completed native
attempt can gain an invocation observation without claiming the handler ran
again.

The harness records the exact success/failure branch it will return to the
cell through its existing `record("cell-call")` action. Its additive annotation
carries the same dispatch identity. `ActionPersistence` commits the `settled`
fact with that controller attempt's succeeded row, using the actual encoded
outcome and validating its result codec. The host operation's success alone
cannot replace a timeout or failure delivered by the harness.

A failed settlement commit returns no completed result and publishes no fact.
On reopen, an already durable succeeded effect crossing can finish that same
controller attempt and fact without rerunning its body. The fact proves a
committed result ready for delivery; a process can still crash before consuming
it and replay it later. This does not promise exactly-once external side effects
or change the existing timeout/reissue policy.

Fact identity is `(native run, "call-fact-v1:<callId>:<phase>", 0)` under the
native journal generation. Exact retries receive the existing commit receipt.
A changed payload under that identity is a conflict. No handler result is
published through a best-effort fallback after a durable write failure.

## Outbox and projections

`EngineJournalProjection` copies committed native entries into the control
journal with its existing source identities. It resumes after a lost receipt
or process reopen; the destination's unique producer key suppresses already
committed copies. Source and destination are separate transactions, so the
bridge can lag and cannot turn an uncommitted source attempt into public state.

Gateway's browser-safe shared call normalizer validates the envelope version,
native coordinates, logical run, and producer identity. Its pure fold prefers
native facts over identified telemetry, keeping the first display position and
stable public node IDs. CLI progress corrects an earlier telemetry outcome
without double-counting. Transcript subscriptions use the existing snapshot
reset when a later native fact changes an already emitted row; fresh snapshots
and resumed subscriptions then agree.

All public inputs, values, and messages remain subject to journal redaction.
An individual field larger than 65,536 UTF-8 bytes becomes a byte count and
canonical SHA-256 commitment. Protected native attempt rows retain the full
encoded result. A public fact cannot reconstruct a credential or a truncated
private value, and no redactor is bypassed.

## Migration and coverage

The writer is additive: no historical rewrite, action-key migration, or trace
identity change is required. A legacy native result acquires a fact only when
the actual annotated record boundary reads it successfully. An invalid encoded
outcome cannot become a deliverable fact.

Legacy trace rows without a call ID retain FIFO matching among unidentified
starts. They cannot safely be merged with new native identities by flow name,
input, or guessed ordinal. Native facts do not fill missing historical model
deltas, printed output, or complete trace prefixes. Low-level custom engine
ports without these annotations remain legacy producers. Native journal
generation gaps remain visible in raw bridge history; the call fold does not
claim complete run-history coverage or authorize work from public projections.
