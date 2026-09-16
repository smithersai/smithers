# Durable command intent

The app's shared command door persists an acceptance before it begins the command. A persisted intent authorizes **one attempt**; it is not a task queue and replay never executes it.

`flows/Commands.ts` applies the same lifecycle to button/slash `run`, `runAsAgent`, `runForAgent`, the HTTP `executeForAgent` tool, and named form `submit`. `AppController` always installs `controller/commandIntents.ts`. Standalone registry unit tests can omit the host lifecycle; the production composition cannot. The gate runs before requirement prompts, deferral, form rendering, chain authorization, binding invocation, or recommendation dispatch. A refused acceptance returns without those effects. A post-receipt check refuses an expired controller/account/turn before invoking the binding.

## Persisted facts and derived state

The `commandIntents` collection is a projection of two semantic events:

- `command.intent.accepted`: stable ID, flow name, actor, source, optional invocation identity digest. The projector adds acceptance time/revision and status `accepted`.
- `command.intent.settled`: ID, matching actor, result category, and an optional typed authorization-refusal retry flag. The projector adds settlement time/revision and status `settled`.

The categories are `executed`, `failed`, `unknown-command`, `unavailable`, and `form`. Duplicate acceptance and a settlement for an absent, already settled, or differently attributed intent are refused. Times and revisions come from the event context, so replay reconstructs the same facts without clocks or effects.

Neither event stores command arguments, form values, credentials, capability grants, live callbacks, or returned result text. Normal domain transitions still record their own state changes. `flow.invoked` remains a bounded diagnostic projection; command intents are separate durable facts and are not evicted with diagnostic retention. Event compaction covers them in the checkpoint. Account sign-out/replacement and app reset scrub private command metadata with the rest of that account's state. If a command deliberately erases its own acceptance, settlement waits for that privacy commit and does not recreate the erased row.

## Identity and attribution

Explicit user requests receive fresh IDs: pressing a command again is a new request, not an implicit retry. Chain calls use a digest over account owner, actor, durable lineage, the durable call-slot fields (chain, link, ordinal, replay key), and flow name. Live AbortSignals are excluded from identity and persistence. HTTP tool calls now supply both the active turn ID and native tool-call ID; their digest includes owner, actor, turn, call, and name. The HTTP path checks that the same turn is still responding before and after the acceptance receipt. Retired chain lineages cannot accept another call.

A duplicate stable call is refused when its original row is accepted or has an ordinary settlement. An accepted duplicate explicitly reports an unknown outcome; a settled duplicate reports that a saved outcome exists. The boundary does not return invented cached output or repeat external work. The chain's own durable result replay remains its result authority.

A typed authorization refusal before target execution is the one safe retry exception. Its settlement records `retryable: true`; approving and resuming that same call creates a new numbered attempt under the same identity digest and awaits a new acceptance receipt. The generic `failed`, `unavailable`, or `form` result never implies retryability. For `form.submit`, the typed refusal of its protected nested target propagates to the outer attempt so the existing approval park can resume. A binding that actually started and then failed remains nonretryable, and a lost refusal-settlement receipt remains ambiguous and nonretryable.

Named form submissions are new gestures and have independent intent IDs. An outer agent `form.submit` still has its stable call identity. The nested form retains the actor that originally asked, so submitting an agent form cannot turn it into a user-authorized command. Automatic onboarding calls are recorded as `system` with source `automatic`; user recency is not changed by those automatic calls.

## Crash and failure behavior

| Failure point | Durable fact | What may have happened | Recovery |
| --- | --- | --- | --- |
| Before acceptance commits, or acceptance fails | No accepted intent | No binding, provider, prompt, or external operation from this command starts | Return a persistence refusal; storage recovery owns further writes |
| Acceptance committed, before binding starts | Accepted | The attempt may not have begun | Keep accepted; do not infer or replay work |
| During binding or after an external service accepts work | Accepted, plus any committed domain observations | External work may have completed, failed, or still be running | Keep outcome unknown until an authoritative domain observation establishes it; no automatic command retry |
| Typed authorization refusal settles before target execution | Settled, retryable | The target binding did not run | A subsequent approval attempt can accept a new numbered attempt; never resume an uncommitted settlement |
| Binding returns but settlement commit fails | Accepted | The binding may already have performed its operation | Return an explicit uncertain-outcome refusal; keep accepted on reload |
| Settlement commits | Settled result category | The registered binding returned that category | Replay reconstructs metadata and state only |
| Sign-out/reset erases the command | Privacy checkpoint/retirement | The privacy operation committed | Preserve erasure; do not recreate command metadata |

`executed` means the **binding returned successfully**, not that every asynchronous workflow it launched has completed. A run's subsequent success, progress, logs, approvals, and failure still come from that run's own observations. A handler failure does not prove that a remote side effect was rolled back. This local journal does not provide a distributed transaction with external services or universal exactly-once execution. Destination-specific idempotency remains necessary where a user chooses to retry ambiguous work.

The journal's replay and bootstrap never iterate accepted rows to run them. Existing boot recovery releases a flow-form's persisted `submitting` flag and states that the previous submission's result must be checked before resubmission; it preserves the draft. Automatic startup remains the existing deterministic practice tutorial path, not a worker for arbitrary command intents.

## Browser activation

A durable receipt is asynchronous. Waiting before asking the browser to reserve a popup or clipboard permission can lose the original user gesture. The command boundary therefore reserves only harmless browser resources synchronously, and passes them explicitly through a per-binding `FlowGesture` context:

- Local web OAuth and app download reserve a fresh `about:blank` window, remove its opener, and navigate it only from the accepted binding. A refused/unconsumed reservation is closed. Native `openExternal` needs no browser reservation.
- Clipboard copy uses a `ClipboardItem` whose text is a pending `Promise<Blob>`. The browser captures activation at `clipboard.write`; the binding supplies bytes only after acceptance. Failed acceptance rejects the pending data, leaving clipboard contents unchanged. Hosts without the deferred clipboard API retain the existing `writeText` path and its explicit browser refusal handling; that fallback cannot guarantee activation across a slow persistence commit.
- A copy submitted through a form reserves at the outer Submit gesture and passes the same reservation through the nested named command. It does not ask for a second gesture after either persistence wait.
- Local repository selection is native RPC, not a browser `showDirectoryPicker`; it begins only after acceptance.

Reservations are scoped to one command, not stored globally or persisted. A model/agent invocation cannot acquire a user gesture reservation. Tests exercise the actual production command handlers with controlled browser APIs and held persistence receipts; they prove call ordering and cleanup, not every browser's permission policy. Native and browser release testing should retain the actual click/key activation canaries.

## Form draft persistence

Generic form drafts already live in the `flow-form` card payload. `form.set` now awaits its card receipt before reporting success or reading dependent harness/file options. Rendering remains a synchronous API, but asynchronous provider reads wait for the rendered card's receipt and stop on failure/disposal. Submission awaits its persisted `submitting` marker before invoking the nested command, which has its own intent gate. Clearing optional fields still replaces the payload durably; no component-local application draft was added.

## Verification

`CommandIntent.test.ts` covers active composition ordering, actual storage commit failure, external-effect/settlement failure and reload, stable chain and HTTP identities, source/actor attribution, durable draft clearing, and privacy erasure. `CommandGesture.test.ts` covers actual download and local OAuth paths plus clipboard and nested form-copy activation, including rejected receipts. `AppTransitionValidation.test.ts` keeps the transition union and runtime schema fields exhaustive.

For native GitHub sign-in, successful command settlement means that the
handoff was created and its system-browser page opened. It does not mean the
account is authenticated. The controller owns a cancellable claim poll and
joins it before releasing storage; accepted session observations establish the
later sign-in outcome. A second explicit gesture reopens the same pending
handoff instead of waiting for the authentication loop or minting another one.
Neither command replay nor application-state replay restarts that external work.

