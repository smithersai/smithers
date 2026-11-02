# Device privacy on session end: wipe on every end (design, revision 13)

The design behind [decision 0151](../../decisions/0151-every-session-end-wipes-the-device.md). Thirteen review rounds by Codex Astra shaped it; section 10 lists each round's findings and resolutions. Step 3 was judged sound to implement in round 13.

Revision 13 corrects revision 12 against Astra's round 12 review (the home-cookie race is closed, stale reveals one bit, and real revocation still answers signed out; two High and one Medium remained). It applies configured-key eligibility to alias arrival, consumes the stale 401 centrally as a retryable transport outcome, classifies `store` under a session-row lock, and records step 1's clock-skew caveat. Revision 12 corrected revision 11 against Astra's round 11 review (round 10's H1-H3, M4 and M5 are closed and the retirement invariant is sound; one High and one Medium remained). It adds a third session answer, **credential stale**, for a live row re-keyed before its new cookie arrived, and closes the orphaned `RecheckRole` redemption (3.12). Revision 11 corrected revision 10 against Astra's round 10 review (the server deadline, `ceased_at`, the deploy gate, the recovery worker and the WAL wording are closed; three High and two Medium findings remained, all in 3.12's continuation). Revision 11 replaces revision 10's lineage, replacement row, grace and alias move with an in-place re-authentication of the same session row (3.12). Revision 10 corrected revision 9 against Astra's round 9 review (the replacement-writer deadlock and the promotion bottleneck are closed; one High and two Medium findings remain) and folds in effectscript-11's 400-day cap with re-authentication (3.12). Revision 9 corrected revision 8 against Astra's round 8 review (H1's normal path, the insert race, the frozen follower and the Web Locks wording are fixed; two High and two Medium findings remain). Revision 8 corrected revision 7 against round 7 (Astra's round 7 review). Steps 0, 1, 1b-additive and 2 are approved and unchanged. Text added in round 6 is marked **(r6)**, round 7 **(r7)**, round 8 **(r8)**, round 9 **(r9)**, round 10 **(r10)**, round 11 **(r11)**, round 12 **(r12)** and round 13 **(r13)**. Section 10 holds the changelog. The decisions stay fixed: wipe on any session end, 30-day sliding sessions, drafts wiped with the count shown. (r10) Added by effectscript-11: a 400-day absolute cap from sign-in, enforced by the server, and a re-authentication before it that continues the session with no wipe (3.12).

Merging architect: Claude Opus.

Inputs:
- the two first designs (Claude Opus and Codex Sol), the server-rendered first-paint design, and a survey of the device's stores;
- Astra's four reviews: Astra's round 1 review, Astra's round 2 review, Astra's round 3 review and Astra's round 4 review;
- the proxy's decisions (effectscript-11):
  - wipe on every session end;
  - sliding expiry;
  - key rotation with an alert;
  - a per-frame socket lease;
  - **the outbox exception dropped**, by the proxy's standing rule after Astra judged it "another recovery protocol". Revision 5 uses the full wipe and shows discarded counts instead;
  - (r10) a 400-day absolute session cap from sign-in, enforced by the server, with a banner from day 393 and a same-person re-authentication that continues the session without a wipe.

Code verified read-only at `cb2399551e61`, and the step 1 and 5 changes at `cba6fdf27e8c`. Paths are relative to `apps/mvp/` unless they start with `packages/`. Section 10 maps every round-4 finding to its fix.

## Decision summary

Every session end clears the device, exactly as explicit sign-out does. That covers expiry, revocation, sign-out on another device and another person signing in. Sessions now last 29 to 30 days after the last session read, and (r10) at most 400 days after sign-in, enforced by the server. From day 393 a non-blocking banner says "Sign in again to keep your session". Signing in again as the same person while the session is live renews the same session row in place for a fresh 400 days with no wipe (r11, 3.12).

Four mechanisms carry the guarantee:

1. **One revocation latch per JavaScript realm.** It is a module singleton in `@smthrs/platform-browser`, so no local layer can bypass it. Every outward path checks it: requests, sockets, both tab RPC systems, the collection coordinator's channel, worker factories, the host's outward calls, and the DOM.
2. **An offline permit in the owner record (SQLite).** It is written only by the leading worker, through conditional, generation-checked statements. That makes one ordered protocol for issuing, extending and revoking it. A device with no permit row does not open offline.
3. **Destruction only after a fresh confirmation.** Revoking the permit is the provisional refusal and can be undone by a later verified activation. The wipe is the destruction, and it runs only when a session read sent after the latch confirms the end. An inconclusive read stays refused but destroys nothing.
4. **The existing sign-out wipe.** That means the mark, the broadcast, and deletion after every holder of `smithers-data` is gone. The first-paint shell's lock hold is transferred to the page without a gap.

The cost, accepted by the proxy:
- Unsent outbox writes, drafts and in-progress client runs are lost, and the authoritative counts are shown.
- The next visit re-syncs cold. The server-authorized first paint covers the cold issue page.
- A device updated while offline cannot open offline until it has been online once.
- (r10) **At day 400, a person who has not signed in again is signed out even while active, and the device's unsent changes and drafts are wiped**, with the counts shown. The banner gives seven days' notice. effectscript-11 accepted this cap.

**Guarantee:** revocation within an observing context, then deletion after every holder releases. Frozen or hung pixels, buffered heap, unobserved ends and older clients are named limits, not guarantees.

## 1. Design twice (decided)

Seal-and-keep (revisions 1-2) and its one surviving piece, the outbox exception (revision 4), are rejected. Four review rounds found receipt freshness, recovery, mirror and retention races in every keep-something protocol. The wipe needs no recovery at all. The confirmation in 3.2 limits its one weakness, destructive false positives.

## 2. The access rule

### 2.1 Server: `repositoryReadable` proof (step 0, Astra-approved)

`repositoryReadable` returns `Readable { viewer, via }` or `Refused { code, status }`, with `resolver: "request" | "cookie"`. The check order:

1. `mayAct`
2. `appAbsent`, for repositories other than the deployment's own
3. the session's role. A `CANT_ACT` role falls through to step 4.
4. the public check

Rules that stay fixed:
- The issue list's runner exception applies only to refusals from steps 3-5, after the deployment and app checks (`worker/github/Api.ts:923-947`).
- A failed `appAbsent` lookup keeps `orElseSucceed(false)`.
- Step 5 moves actions (adds `mayAct` and `appAbsent`), compare (adds only `appAbsent`; it already checks `mayAct` at `:1102`) and home `mayRead` onto the proof. Each is a policy change with differential tests.
- First paint uses `resolver: "cookie"`.
- Every outcome is `private, no-store`.
- Timing differences are disclosed, not denied.

### 2.2 Device: when private content may exist and render

> 1. Device data opens **online** only on a verified activation, and **offline** only when the owner record holds a permit with `permit_until > now`. `authorize` checks this immediately before it succeeds and before the engine exists (`packages/smithers/flows/platform-browser/src/internal/engine.ts:136-140`). A device with no permit row does not open offline.
> 2. A context that observes an end sets its latch in that task and asks the leader to revoke the permit. After a confirming session read, the device runs the wipe.
> 3. A memory tab accepts authenticated responses only after its own session answer has fixed its viewer and deadline (3.6). It reloads when either ends.
> 4. The first-paint seed exists only inside an uninterrupted `smithers-data` hold, before its session deadline (3.10).

## 3. Mechanism

### 3.1 Observing an end

`verdict(viewer V, decoded 2xx answer S)` behaves as in revisions 3 and 4:
- an answer that is not decoded, or a 5xx, keeps the data;
- if V is unset and S is signed in, reopen or adopt;
- if V is set and S is signed out, **ended**;
- (r12) if S is **credential stale** (3.12), **neither**: the row is live, but this browser's cookie predates a re-key. The realm holds (3.12) and confirms nothing;
- if V is set and S names someone else, **replaced**;
- (r11) if V is set and S names V under another **session tag** (3.12), **replaced**: the session V held ended and a new row began. S naming V under the device's session tag is the same session row, possibly re-authenticated in place.

Observers:
- **Tab.** Session answers through `boundFetch` (startup, `online`, retry, the re-read after a 401, and the visible check every 60 s), the tab's deadline, and `authorize`'s `ended`/`replaced` outcomes.
- **Worker.** Its own reads: the prestarted read (`src/flows/sessionStart.worker.ts:8`), leader checks (`src/flows/engine.worker.ts:71-75`), adoption, and its own 401s. When a worker observes an end, it sets its own latch. If it leads, it commits the permit revocation itself. It then posts `end` to its tab and on the wipe channel. (r8) After the revocation commits it follows the control lifecycle (3.5.1) instead of closing at once.

`authorizeDevice` (`src/device/identity.ts:121-217`) returns these outcomes:

| Outcome | When | Then |
|---|---|---|
| `ended` | signed out, with a person recorded as owner | refuse; the tab confirms (3.2) |
| `replaced` | a different person, on a recorded stable-id owner; (r11) or the same person under a session tag other than the owner record's `session_tag` | refuse; the tab confirms (3.2) |
| `refused_offline` | offline, and no permit, a revoked permit or a permit past its time | refuse; destroys nothing |
| legacy (no owner record) | as decision 0023 rule 3 | memory, no wipe |

### 3.2 The end: latch, revoke, confirm, wipe (round 4 #3)

**In the observing tab's task:**

```
 1. Revocation.revoke()            the realm latch (3.4 lists what it gates)
 2. identity channel: { request: "revoke", incarnation, genSeen } to the leader. This is the provisional refusal, and it
    survives a reload. (r6) genSeen is the permit generation in this tab's receipt (3.5).
    (r7, r8 reworded) Before sending, **request** the Web Lock "smithers-admit" in exclusive mode. The request is
    asynchronous: this step never awaits the grant, and nothing in steps 3-5 waits for it. "Revocation requested" is
    this moment; "exclusive barrier acquired" is the later grant. An activation that already holds "smithers-admit"
    shared finishes its commit first (Web Locks do not revoke a held lock); it is a new-build context, so it hears step 5's
    broadcast and the leader's revocation, and latches like any running page. Once granted, the observer holds the
    lock until the revocation's outcome is final (3.5.1): the confirmed revocation is acknowledged, or the confirmation
    is superseded, or the mark is written. Every activation takes "smithers-admit" shared around its commit (3.5), so
    after the grant no context in this origin can admit the device store while an observed end is not yet durable.
 3. <html data-ended>; remove #first-paint; drop the seed and pending completions; document.title = "Smithers"
 4. root.unmount(); terminate code-intel workers. (r7) The engine worker is never terminated before the revocation is
    acknowledged. On { revoke } the leader enters revoking mode (3.5.1): it interrupts its engine runtime and calls
    the new SDK operation `SqlConnection.quiesce` (3.5.2), which stops admission, lets the running statement finish,
    rolls back whichever owner holds an open transaction (a frozen follower's included) and keeps the connection for
    control statements. (r8: rev 7 cited SqlConnection.ts:467, which waits for another owner's transaction and rolls
    nothing back.) It retries the revocation until it commits, acknowledges, and then **stays alive as a control-only
    writer** until the outcome is final (3.5.1). The engine's private work is fenced at once; only this control path
    stays alive.
 5. postMessage("end:pending") on the wipe channel        other new-build tabs run steps 1-4
--- task ends ---
 6. confirm through Revocation.confirmSession(): an unbound GET /api/auth/session sent now (the identity read decision
    0023 rule 5 already leaves unbound; boundFetch is latched)
      - names V under the device's session tag -> superseded: reload, destroy nothing. The next verified activation
                                    issues a new permit. (r11) Only the same session row supersedes (3.12).
      - signed out, names another, or names V under another session tag (r11) -> wipe (step 7)
      - (r12) credential stale       -> the row is live, so the end is not confirmed: treated as inconclusive, below.
                                    Destroys nothing.
      - 503, timeout or offline  -> inconclusive: reload, destroy nothing. The permit is revoked, so the boot refuses
                                    offline. An online boot's activation is the confirmation (`ended` or `replaced`
                                    -> step 7; verified -> new permit).
 7. wipe: send { request: "revoke", incarnation, confirmed: true } (r6, 3.5); write smithers-discarded-drafts (3.11) and
    the mark "1"; postMessage("wipe"); race stop() against 1 s; reload. (r8) The confirmed request goes to the
    control-only leader that acknowledged the provisional one (3.5.1). If that leader is gone, the next worker to lead
    commits the confirmed revocation itself in `authorize`, before admission (3.5.1, "replacement writer"), so a failed
    mark write never leaves only the provisional NULL permit.
```

**What `ended` means now.** Revoking the permit is a provisional refusal that a later verified activation undoes. The mark is the confirmed destruction. A worker's revocation followed by a tab's superseded confirmation is therefore consistent: no wipe, and the next activation issues a new permit.

**The one ordering residual.** (r7, narrowed) After a confirmed revocation commits, `wipe_confirmed` blocks every new-build activation, including P's own re-sign-in, which gets a memory runtime until deletion completes (3.5). P's re-sign-in in that window can therefore persist nothing to the store. Only memory-runtime state from that window is lost at the reload. A re-sign-in between the confirming read and the confirmed revocation is also refused, after the revocation commits.

**If the revocation was not acknowledged.** When there is no ack and the confirmation is inconclusive, the tab does not reload. It stays hidden, holds (once granted) `smithers-admit` exclusively, and retries the confirmation every 5 s. The leader keeps retrying the revocation. While the observer lives and its barrier is acquired, no new context can admit the store (r7). Section 3.6 states the residual.

**Memory tabs** run steps 1, 3 and 4 and reload. They write no mark and broadcast nothing.

**Explicit sign-out** runs steps 1-5 when ChatApi accepts it, then step 7. The person asked, so no confirmation is needed.

### 3.3 Every tab and lifecycle

- **`end:pending` or `wipe` messages:** steps 1-4 synchronously in `onmessage`. On `wipe`, reload.
- **`storage` event showing the mark present** (after a re-read): the same, on retained tabs only.
- **`resume`, `pageshow` or visible:** a retained tab with the mark present runs the same steps. (r11) A realm past `receipt.deadline`, or whose deadline timer fires, first runs the deadline check (3.12) under the reversible hold; a fresh, live answer for the same person and session tag releases the hold; a confirmed end latches at once; anything else latches and runs the same steps.
- **`pagehide` (persisted):** set `data-ended`.
- **Older builds.**
  - **Running older tabs** reload on any channel message, but their leave waits on `stop()` with no timeout (`src/wipe.ts:116-120`), and they have no latch.
  - **Older cached boots** finish a marked wipe. They ignore the permit and open the owner's data offline as before (`src/device/identity.ts:162-166`).

  Both are named limits. A deployment cannot retrofit them.

### 3.4 The latch: one per realm (round 4 #5)

`Revocation` is a module singleton in `@smthrs/platform-browser`: a boolean plus `revoke()` and `confirmSession()`. Every constructor below reads it directly, so a local layer cannot route around it.

| Path | Gate |
|---|---|
| `boundFetch` (`src/device/identity.ts:311`) | Refuses new requests and aborts in-flight ones. Returns no response after the latch. Bytes already buffered in a returned response or its clone are retained heap (round 3 #7). |
| `TabChannel` (`packages/smithers/flows/platform-browser/src/TabChannel.ts:150-170`), **every instance**, including those `SharedSqlite.open` (`SharedSqlite.ts:366`) and `BrowserRuntime.run` (`BrowserRuntime.ts:317`) install | `open` refuses, `post` is a no-op, subscriber queues shut down. `answerAskingTab` (`src/flows/askingTab.ts:91-100`) runs each handler in a scope registered with the latch, which interrupts it. A handler that keeps running has no `post`, so the reply never leaves. |
| **`BrowserCollectionCoordinator`** (`src/main.tsx:313`; its own BroadcastChannel, which carries committed rows) | The latch calls the tracked instance's `dispose()`. That closes its channel synchronously, so **no row is broadcast** after the latch. (r6, corrected claim) Disposal does not stop a write the database already admitted: the post-persistence check suppresses only publication (`broadcast-coordinator.ts:2074`, `:2446`). Persistence stops at the commit boundary instead. After committing a revocation, the leader serves no further SharedSqlite statement from any tab and stays control-only until its exit (3.5.1). Any statement admitted before the revocation commits before it, because SharedSqlite serializes statements. |
| `tabPort.answer` | stop (`src/flows/tabPort.ts:168`) |
| Worker factories | `engineWorker` and `codeIntelWorker` return `failedWorker`. (r10) The one exception is `Revocation.recoveryWorker()` (3.5.2), which can start no private work. (r11) Every gate in this table also has a reversible **hold** state (3.12) |
| Sockets | `sealedSockets` (3.9) |
| Host | `title.write`, `clipboard`, `web.openTab`, `navigate` and `reopenRoute` become no-ops |
| Outbox | Admission refuses. Sends go through `boundFetch`, which is latched. |

The test holds a collection transaction, a queued asking-tab call and a socket frame across the latch, then releases them. Nothing is posted, broadcast, fetched or rendered.

### 3.5 The permit protocol, ordered by the leader (round 4 #1, #2)

The permit lives in the owner record (`smithers_device_identity`, `src/device/identity.ts:60`). It adds two columns, `permit_until INTEGER NULL` and `permit_gen INTEGER NOT NULL DEFAULT 0`, and (r11) `session_tag TEXT NULL` (3.12), the same way `owns_unstamped` was added (`:138-142`). Only the leading worker writes them, through SharedSqlite, which serializes statements. Every operation is conditional:

| Operation | Statement | Who |
|---|---|---|
| Issue (r6) | Only when `permit_until IS NULL` (never issued, or revoked) **and `wipe_confirmed = 0`** (r7). `authorize` reads `permit_gen` **first**. It then sends a **new** session request, one dispatched after that read. The prestarted read (`src/flows/sessionStart.worker.ts:8`, `src/flows/sessionRead.ts:24-25`) never issues a permit. On a verified answer it runs `SET permit_until = :d, permit_gen = permit_gen + 1 WHERE permit_gen = :genAtStart AND permit_until IS NULL AND wipe_confirmed = 0`. If no row is updated, the activation is refused. (r11) The answer must name the owner under the record's `session_tag`; a NULL `session_tag` (a record from before this change) adopts the answer's. Another tag is `replaced` (3.1). | `authorize` |
| Admission (r7) | Every activation's final check and its `activation.allow()` run while holding `smithers-admit` in shared mode: in the worker's `authorize` before it succeeds, and in the tab's `accept`. Workers have Web Locks. When `wipe_confirmed = 1`, `authorize` returns `wipe_pending`: no engine, and the tab writes the mark and reloads, so the boot deletes. If the mark write fails, the device simply stays refused, online or offline, for every person, until a later boot writes it. | `authorize`, tab |
| Open with a valid permit (r6) | When `permit_until IS NOT NULL`, the prestarted answer may decide. Verified, it extends: `SET permit_until = max(permit_until, :d) WHERE permit_gen = :genAtStart AND permit_until IS NOT NULL`, with no generation bump. A revocation committed before `authorize` read the generation left the permit NULL, so this row does not apply; the issue row's fresh read does. A revocation committed after that read changed the generation, so the update fails. | `authorize` |
| Extend | `SET permit_until = max(permit_until, :d) WHERE permit_until IS NOT NULL AND permit_gen = :gen AND session_tag = :tag` (r11), where `gen` comes from the tab's receipt. (r10) After it commits, the leader posts `{ deadline, gen }` on the identity channel and every tab re-arms its deadline timer (3.12). | a tab, on an answer naming the owner under its session tag, by `{ extend, tag }` message |
| Revoke, provisional (r6) | `SET permit_until = NULL, permit_gen = permit_gen + 1 WHERE incarnation = :inc AND permit_gen = :genSeen`. Only issue and revoke bump the generation, so `genSeen` goes stale only after a full revoke and re-issue cycle. A stale request is acknowledged as `stale`, changes nothing, and the tab's confirmation (3.2 step 6) decides. Repeating a request is idempotent. | the leader, on `{ revoke }` |
| Revoke, confirmed (r7) | `SET permit_until = NULL, permit_gen = CASE WHEN wipe_confirmed = 1 THEN permit_gen ELSE permit_gen + 1 END, wipe_confirmed = 1 WHERE incarnation = :inc`. Repeating it is idempotent. `wipe_confirmed` is cleared only by deletion: the whole record goes with the directory. It is sent only after a confirming read dispatched after the latch, and it precedes the mark. The confirmed destruction is therefore durable in the device database even when the mark write fails. | the leader, on `{ revoke, confirmed }`, or on its own confirmed observation |
| Revoke: serving (r6, r8) | After any committed revocation, the leader serves no SharedSqlite statement from any tab and acknowledges. (r8) It does **not** close at once: it stays a control-only writer until the outcome is final (3.5.1). A new leader's `authorize` sees a NULL permit and issues only through a fresh read. | the leader |
| Pending requests first (r9) | Every elected writer subscribes to the identity channel **before anything else in `authorize`**, before its own session read and before it requests admission. Any `{ revoke }` or `{ revoke, confirmed }` that arrives while `authorize` runs (the observer resends every 5 s) is committed at once on the `@authorize` owner and acknowledged, whatever the writer's own session answer says. A committed confirmed request ends `authorize` with `wipe_pending`. None of this needs admission. | every elected writer, in `authorize` |
| Confirm in `authorize` (r8) | When `authorize`'s fresh session read (dispatched after it read the generation) answers `ended` or `replaced` on an owner record with a NULL permit, it commits the confirmed revocation itself, on its `@authorize` owner (`packages/smithers/flows/platform-browser/src/internal/engine.ts:136-140`), counts drafts in the same transaction, and returns `wipe_pending`. This write needs no admission (it opens nothing private), so it runs even while an observer holds `smithers-admit`. | `authorize`, the replacement writer |
| Check | offline: `permit_until IS NOT NULL AND permit_until > now`, evaluated immediately before `authorize` succeeds. Online and verified: also `now < sentAt + (expiresAt - serverNow)` at that moment, so a delayed answer past its own lifetime refuses. | `authorize` |

#### 3.5.1 Revocation control lifecycle (r8, finding 1)

The writer that commits a revocation is the worker holding the engine's Web Lock (`options.name`, `packages/smithers/flows/platform-browser/src/internal/Leader.ts:570`). Only one worker holds it, so there is one writer at a time, and ownership passes only through that lock.

| State | Entered on | Does | Leaves to |
|---|---|---|---|
| serving | election and a passed `authorize` | everything, as today | revoking, on `{ revoke }` or its own observed end |
| revoking | `{ revoke }` | interrupts the engine runtime; `quiesce` (3.5.2); commits the provisional (or confirmed) revocation, retrying with backoff 250 ms to 5 s until it commits | control-only, after the commit and ack |
| control-only | committed revocation, acked | keeps the engine lock and the quiesced connection; serves nothing to tabs; accepts only `{ revoke }` and `{ revoke, confirmed }` (idempotent by incarnation), and re-acks a repeat; requests `smithers-admit` in **shared** mode as its exit signal | closed: (a) the confirmed revocation committed and was acked; or (b) its shared `smithers-admit` request is granted, which means the observer released or closed (superseded, mark written, or tab gone); or (c) the engine lock is lost |
| closed | any exit above | releases the engine lock; the leadership scope closes the database (`BrowserSqlite.ts:314`) | none; the next worker elected starts at `authorize` |

- **Replacement writer.** A worker elected after a control-only leader closed runs `authorize` first, as every leader does (`engine.ts:136`). (r9) It first commits any pending request it hears (3.5, "Pending requests first"): a confirmed request was decided by a confirming read dispatched after the latch, so it stands even if the owner has signed in again since; the writer commits it and returns `wipe_pending` without consulting its own answer. Only when no confirmed request is pending does its own fresh read decide: `ended` or `replaced` commits the confirmed revocation (3.5, "Confirm in `authorize`"), with no admission, and returns `wipe_pending`; verified issues a new permit (superseded); inconclusive refuses and destroys nothing. It requests shared admission last, so it never waits on the observer's exclusive barrier while holding work the observer waits for. (r9, finding 1: rev 8 consulted only the writer's own read, which deadlocked when the owner had re-signed in.)
- **The observer's own worker** is never terminated before an ack (3.2 step 4), so if the old leader is gone it is a candidate to lead, and its `authorize` is the replacement writer. The observer resends `{ revoke, confirmed }` every 5 s until a leader acks or `wipe_pending` arrives.
- **Shutdown is bounded by its exits**, never by a missing message: a control-only leader whose observer reloads exits through (b). A control-only leader with a live but silent observer waits, which is the barrier working as intended (3.6).
- **Tests:** (r9) all three together: the provisional revocation commits, its leader's tab is closed, the observer's confirmation reads signed out, its mark write fails (localStorage throws), and the owner signs in again before the replacement elects. The replacement commits the confirmed revocation from the observer's resent request within 5 s, acks, returns `wipe_pending`; the observer releases; the re-signed-in page gets a memory runtime; the next boot deletes. Also: provisional ack, then confirmation 10 s later, commits `wipe_confirmed` on the still-alive control-only leader; provisional ack, the leader's tab closed, confirmation signed out and the mark write failing (localStorage throws): the next online activation commits `wipe_confirmed` in `authorize` and the device deletes; the same with the next boot offline: refused, nothing destroyed, then online and signed out: wiped; superseded confirmation: the control-only leader exits through (b) and the next activation issues a permit.

#### 3.5.2 `SqlConnection.quiesce` (r8, finding 3)

New in `packages/smithers/flows/platform-browser/src/internal/SqlConnection.ts`, beside `run` and `abandon` (`:443-498`):

```ts
quiesce: (control: string) => Effect.Effect<void>
```

1. **Stop admission.** A flag every `run` checks first. Calls from any owner but `control` fail with `Quiesced`, including callers parked in the `Wait` branch (`:476-478`), which re-enter `run` and fail.
2. **Settle the current statement.** Take the statement permit. A statement runs uninterruptibly once started (`:463-465`), so this waits only for it to finish.
3. **Roll back the current owner.** If `holder` is set and is not `control`, run `ROLLBACK` directly, resolve its `released`, and mark that owner lost, so its later continuing statements fail `TransactionLost` (`:461`). This does not wait for the owner's client lock, unlike the follower watcher (`Leader.ts:425-440`), so a **frozen follower's** open transaction no longer blocks the revocation.
4. **Keep the connection.** `control` keeps running statements on the same connection; there is no reopen. The connection closes only with the leadership scope (3.5.1, closed).

**Failure transitions and the watchdog** (r9, finding 3). `quiesce` waits for a running statement, which is uninterruptible (`SqlConnection.ts:469`) over a loop with no deadline (`Statements.ts:108`), and a failed `ROLLBACK` poisons the connection (`SqlConnection.ts:363`). A timeout inside the worker cannot fix either, so recovery is external and goes through ownership:

| Condition | Detected by | Then |
|---|---|---|
| `quiesce` not done within 5 s (hung `step()`) | a timer in the worker, or, if the worker's event loop is blocked, its tab: the tab that hosts the leading worker arms a watchdog on `end:pending` or `{ revoke }` and expects the worker's `revoked` ack within 10 s | the worker posts `stuck`, or the tab gets no ack in time |
| `ROLLBACK` or the revocation statement fails with the connection poisoned | `quiesce`'s or the revocation's error | the worker posts `stuck` |
| either | the hosting tab | terminates the worker (`worker.terminate()`). That destroys its realm, so the engine Web Lock and the OPFS access handles are released. Nothing else is stopped |
| after release | the next worker to win the engine lock, in any tab; (r10) in the latched observer's tab, its **recovery worker** (below) | opens the database afresh. (r10) The database runs in WAL mode with `synchronous = FULL` (`packages/smithers/flows/platform-browser/src/BrowserSqlite.ts:301`), and the VFS keeps the WAL file and flushes on sync: a revocation that committed before the kill is durable in the WAL; a transaction killed before its commit left only uncommitted frames, which WAL recovery ignores on open. It then commits the pending requests first (3.5) |

**(r10) The recovery worker.** The latch makes the observer's `engineWorker` return `failedWorker`, and the factory also refuses once activation is memory-only (`src/main.tsx:393`). Revision 9's "the observer's tab spawns a fresh engine worker" was therefore impossible: with one tab, a killed leader had no replacement and the revocation never committed. Revision 10 adds one latch-exempt path:

- **Creation.** `Revocation.recoveryWorker()` is the only factory the latch allows. It starts only in a latched realm that has a pending, unacknowledged `{ revoke }` or `{ revoke, confirmed }` and has terminated (or never had) a leading worker, at most one at a time. It constructs `src/device/recovery.worker.ts`, a separate entry.
- **What it can do.** It requests the engine lock, opens the database through `BrowserSqlite`, and runs only the control path: the pending requests its tab hands it in its first message and any it hears on the identity channel, each committed as in 3.5 (the confirmed one with the drafts count `D` in its transaction), then acks. It then behaves as a control-only leader (3.5.1) with the same three exits.
- **What it cannot do.** Its module graph has no engine, no collections, no `SharedSqlite` server, no `fetch`, no socket and no `TabChannel`; a bundle test asserts the graph. It serves no statement to any tab and issues no permit. It never reads a session, so it cannot decide anything: every decision comes from the observer's confirmation.
- **The barrier.** The observer's realm owns its granted exclusive `smithers-admit` and its pending requests. Terminating a worker does not release a lock the document holds, so the barrier and the 5 s resends survive the kill and the recovery worker's start.

The observer keeps its exclusive admission barrier throughout, so nothing is admitted between the kill and the replacement's commit. Ownership passes only through the engine lock, which is released only when the stuck realm is gone. If every candidate's OPFS hangs, the barrier holds while the observer lives, and the 3.6 residual applies after it closes. Tests, apart from frozen tabs: a VFS stub whose `step()` never settles during `quiesce` (the tab kills the worker, the replacement commits); a VFS that fails `ROLLBACK` (`stuck`, kill, replacement commits); a hung `step()` in a worker whose event loop is blocked (the tab's 10 s watchdog fires). (r10) **Exactly one tab:** its own leader hangs, the end is observed, the watchdog kills the worker, the latched tab starts the recovery worker, which commits the provisional revocation, then the confirmed one with `D`, acks, and the tab writes the mark and the next boot deletes; the same with an inconclusive confirmation (the recovery worker stays control-only and the tab retries every 5 s); a bundle test that the recovery worker's graph has no engine, collection, fetch, socket or channel module. (r10) **Real OPFS termination** (Chromium, no stub): the worker is terminated immediately before the revocation's `COMMIT`, then the next open shows the permit unchanged and the replacement commits it; terminated after `COMMIT` and before the ack, then the next open shows the revocation, and the observer's resend is acknowledged as already revoked (a repeat of a committed provisional request matches no row and is acked `stale` with the current permit, NULL, which the observer counts as revoked; a repeat of a confirmed request is idempotent).

The leader calls `quiesce("@revoke")` on entering revoking mode, and `serveStatements` (`Leader.ts:470-540`) answers every later `Execute` with a refusal. A **frozen leader** is a different case: nothing runs on it, the observer's request has no recipient, the barrier and the 3.6 residual cover it, and the leader's own resume runs the revocation first.

Tests (separately): a follower that opened a transaction and froze (CDP `Page.setWebLifecycleState frozen`): the revocation commits within one statement time, and the follower's thawed `COMMIT` fails `TransactionLost`; a frozen **leader**: the revocation waits, nothing is admitted while the observer's barrier is held, and the leader commits on resume; a running statement during `quiesce`: it completes, then nothing else is admitted.

A revocation bumps the generation. A stale extension or issue can therefore never recreate a revoked permit (round 4 #2). Every retained receipt carries `deadline = permit_until` and `gen`. The tab arms its timer before `activation.allow()` (round 3 #1).

**No migration exception** (round 4 #1). A device with no permit row, or a NULL `permit_until`, does not open offline. Unmigrated and revoked devices behave the same, so nothing has to tell them apart. An existing device gets its first permit at its first verified online activation under the new build. Offline use resumes from then on. Storage denial no longer matters, because the permit is not in localStorage.

### 3.6 Durability of the refusal, and the residual (round 3 #6, round 4 #1)

Once the leader commits the revocation, every new-build boot refuses offline, whatever happens to localStorage. Once the mark is written, every build deletes. The refusal is lost only in this case, all three together:
- the end is observed while no leader can commit, for example the leader's tab is frozen, or OPFS writes fail;
- **the observing document is then closed** (r7). While it lives and holds its granted exclusive `smithers-admit`, it blocks every admission in the origin (3.2 step 2). (r8) An activation that already held `smithers-admit` shared when the end was observed finishes first; it is a running new-build context and latches on step 5's broadcast or the revocation;
- the next boot is offline and finds an unrevoked permit.

This residual is accepted and named, with a test. Without a durable write somewhere, no design can carry a refusal across a closed document. The test (r7) covers a blocked revocation, an inconclusive confirmation, and a fresh offline tab opened **while the observer is still open**: that tab waits at admission. (r8) A second test starts an activation, holds it inside its shared `smithers-admit` hold, then observes an end in another tab: hide, unmount and broadcast happen before the exclusive grant; the activation completes, receives `end:pending` and latches; the exclusive barrier is acquired after it releases; no later activation is admitted.

### 3.7 Memory tabs: lifetime contract (round 4 #9)

A memory tab is one whose activation refused the device store: a legacy owner, `refused_offline`, a failed wipe, or failed storage.

1. **Before any non-session `/api/` request leaves**, `boundFetch` holds it until the tab has its own decoded session answer. That answer fixes the viewer (its person or none) and the deadline, `sentAt + (expiresAt - serverNow)`. Offline, requests stay held. Nothing authenticated can arrive, and the tab shows the public and offline pages.
2. **Requests carry the viewer** as `x-smithers-device-person`. A mismatched cookie reads as nobody (`worker/RunCredentials.ts:224-235`). **(r6)** A viewer of "none" sends the new value `@anonymous`. `resolveWith` (`:226-233`) returns no actor for it, whatever cookie or bearer comes with it. A tab whose viewer is none therefore never receives a signed-in person's data, even if another tab signs in first. `@none`, which stays unbound (`:228`), is now sent only on session discovery, the identity read that fixes the viewer. Older servers treat `@anonymous` as a person id that matches no actor, so they already return nobody. This needs no server-first ordering; the server change makes the outcome explicit and countable. Tests: none to Q (a request race against another tab's sign-in) and Q to R.
3. **The viewer's deadline** lives in memory, and so does the expiry timer. Passing it, or an answer that is signed out or names someone else (Q to R), counts as an end: latch, then reload, with no wipe. (r11) An answer naming the viewer under its session tag moves the deadline (3.12); the timer runs the deadline check, under the hold, before it counts as an end.
4. **Tests:** Q in a memory tab expiring offline; Q to R; a boot with failed storage.

### 3.8 Sliding expiry, cookies and key rotation (round 4 #7, #8)

**Renewal.** `GET /api/auth/session` renews the home session at most once a day:

```sql
UPDATE sessions SET expires_at = now() + make_interval(secs => $maxAge)
WHERE id = $home AND revoked_at IS NULL AND expires_at > now()
  AND expires_at < now() + make_interval(secs => $maxAge) - interval '1 day'
```

An alias renews its parent (`worker/SessionStore.ts:182-190`). Lifetime is therefore **29 to 30 days after the last session read**.

**(r6) Cookies change only at sign-in and sign-out.** Revision 5 refreshed the cookie on every answer. A delayed response could then reset P's cookie after Q signed in (RFC 6265 §4.1.1), so revision 6 removes per-answer refreshes. Instead:
- **New cookies.** New session and alias cookies are set at sign-in (`worker/SignIn.ts:667`, `:784-788`) with `Expires` = the row's deadline. (r10) That attribute is hygiene only: nothing relies on it. The server decides whether a session is live from its sliding `expires_at` and its absolute deadline. A cookie kept after the server ends the session only reads as signed out.
- **Hard limit (r10).** Sessions renew with use up to an absolute deadline 400 days after sign-in, enforced by the server (below). A same-person re-authentication before it starts a fresh 400 days with no wipe (3.12).
- **Cookies issued before this change** keep their 30-day `Max-Age`. They end at their original time, as today, and are replaced at the next sign-in.

No session-read response sets the session cookie, so no delayed session read can overwrite a newer authentication. (r7, narrowed) A delayed **sign-out** response can still expire a newer sign-in's cookie (`worker/SignIn.ts:839`). That needs a person who pressed sign-out and signed in again before the sign-out answered. The effect is a sign-out, then a wipe, of the newer session. It is named in section 8, and authentication mutations are not ordered. Alias hosts need no refresh, because their parent's renewal extends them server-side.

**(r6) Key rotation rotates the signing key only.**
- **Two secrets.** `SessionKeys.make` (`worker/SessionKeys.ts:43-70`) takes an encryption secret, `SESSION_SEAL_SECRET`, separate from the signing secret. When it is unset, the encryption secret is `SESSION_SECRET`, so existing ciphertext keeps opening. The first rotation sets `SESSION_SEAL_SECRET` to the old `SESSION_SECRET`, so encryption never changes.
- **What uses the encryption secret today:**
  - `sessions.github_access` and `github_refresh` (`worker/SignIn.ts:744-759`);
  - the PKCE verifier in `sign_in_attempts` (`:427`, `:711`);
  - the sealed replacement tokens journaled by `RecheckRole` (`worker/flows/RecheckRole.ts:50`, `:207-211`).

  Personal, secrets and runner credentials use the separately versioned `secrets/Keys.ts`.
- **Encryption-key rotation is out of scope.** If it is ever needed, it requires its own design, with versioned ciphertext in rows **and** durable journals, conditional re-seal, and retirement gated on both.
- **Signing rotation.**
  - `verify` accepts `SESSION_SECRET_PREVIOUS`, and `sign` uses the current key.
  - (r7) **Each session records which key signed its cookie** (`sessions.cookie_key`, `host_sessions.cookie_key`; existing rows backfill to the current key id).
  - (r9, design twice) **Retirement by time, not by counting sessions.** Two options were compared:
    - *Re-sign at renewal* (the proxy's suggestion): a renewal re-signs the cookie with the current key and stamps the row, and an old key verifies until a count of live rows stamped with it reaches zero. Rejected: re-setting the cookie on a session read brings back round 5's finding 4 (a delayed response overwrites a newer sign-in's cookie, RFC 6265 §4.1.1), and the count still races a renewal that crosses expiry (round 8 finding 2), because the renewal and the stamp change which rows are live under which key.
    - *Expiry-bounded retirement* (chosen): no cookie is ever re-signed, every new cookie carries an absolute end, and an old key stays verifying until every cookie it could have signed has expired in the browser. Retirement then depends on no session row, so renewals, aliases and their parents cannot race it, and there is nothing to count or lock.
  - (r10) **A server-enforced absolute deadline** (round 9 finding 1; revision 9 relied on the browser's `Expires`, which clock changes, delayed responses and copied cookies defeat). Each row carries `cookie_key` (r7, the row's signing key id) and (r11) `started_at timestamptz NOT NULL`, backfilled from `created_at` (`db/migrations/0005_sign_in.ts:44`, `0074_host_sessions.ts:30`). Both are written together, by the insert or by an in-place re-authentication (3.12), in the statement that read the issuer, with `started_at = now()`. A home session's deadline is `s.started_at + interval '400 days'`; an alias's is `least(h.started_at, s.started_at) + interval '400 days'`, never later than its own. (r11) **Key equality:** `keys.verify` reports which configured key verified the cookie, and every live predicate also requires `cookie_key = :verifiedKey`, so a cookie signed by an earlier key stops authenticating once its row is re-stamped. (r12) Such a cookie, validly signed by a configured key, for a row that is live but stamped with another key, gets a third answer, `credential: "stale"`, never "signed out" (3.12). It authenticates nothing: every other route refuses it with 401 and `x-smithers-credential: stale`. One SQL fragment, `sessionLive`, adds `AND <deadline> > now()` to every predicate that accepts a session: `findLiveBy` (`worker/SessionStore.ts:137-149`, so `findLive` and `findLiveById`), `findHostLive` (`:182-196`), `deploymentMember` (`:160-169`), the role check's `Held.live`, and the socket lease's revalidation (3.9). A test lists every `SessionStore` export that reads `sessions` or `host_sessions` and fails if one omits the fragment. A `Live` held in memory carries its deadline, and every resolver refuses it past that. Renewal sets `expires_at = least(now() + maxAge, deadline)`. (r11) Every answer's `expiresAt` is the earliest end the server knows for that row at answer time; the client rejects an answer whose `sentAt + (expiresAt - serverNow)` has elapsed before admission, extension or releasing a hold. The session answer returns `deadline` beside step 1's `expiresAt` (now `least(expires_at, deadline)`) and `serverNow`. A cookie therefore authenticates nobody after its row's deadline, whatever the browser's clock, the response's delay or where the cookie was copied.
  - (r8, kept) **The issuer comes from durable key state.** `session_signing_keys (key_id text PRIMARY KEY, state text CHECK (state IN ('issuer', 'verifier', 'retired')), promoted_at timestamptz, ceased_at timestamptz)` (r10: `ceased_at` replaces `demoted_at`); exactly one row is `issuer`. The session insert (`worker/SignIn.ts:751`) and the alias insert (`:656`) read the issuer row **without locking it**, record its id as `cookie_key`, commit, and then sign with that key (`:772`, `:658`). A Worker whose configuration lacks the issuer fails the sign-in closed (`smithers_auth_issue{outcome: issuer_unconfigured}`). (r9) No `FOR SHARE`: promotion no longer waits on issuers (finding 4).
  - (r9) **Bounded issuance transactions.** Each issuance transaction sets `SET LOCAL statement_timeout = '5s'`, `lock_timeout = '2s'`, `idle_in_transaction_session_timeout = '10s'` and, on PostgreSQL 17 (Neon), `transaction_timeout = '15s'`, and takes locks in one order: `people`, then `sessions` or `host_sessions`. A stalled issuer is terminated by the server and rolls back, holding nothing that promotion needs.
  - (r10, r11) **Why retirement is safe.** A cookie signed by K authenticates only while its row's `cookie_key = K` (key equality). A row gets `cookie_key = K` only from an insert or an in-place re-authentication whose statement read K as issuer, so its snapshot predates the promotion's commit, and the same statement set `started_at` to its transaction's start, earlier still. `ceased_at` is read with `clock_timestamp()` **after** the promotion commits (below), so every row currently stamped K has `started_at <= ceased_at`, however long the promotion stalled and however long an issuer took. The server accepts no row past `started_at + 400 days` (or an alias's earlier bound), and a re-authentication that moves `started_at` later also moves the row to the current issuer. So after `ceased_at + 400 days`, no K-signed cookie authenticates anyone, and dropping K changes no answer. This reads no session row, counts nothing, and depends on no browser.
  - (r10) **Staged rotation.** (a) Add the new key to every Worker's configuration and insert its row as `verifier`. (b) Promote in one short transaction with `lock_timeout = '2s'`, retried on timeout: the old issuer becomes `verifier`, the new key `issuer`. Nothing waits on issuers. (c) **After that commit**, in a separate statement, record cessation: `UPDATE session_signing_keys SET ceased_at = clock_timestamp() WHERE key_id = :old AND state = 'verifier' AND ceased_at IS NULL`. The rotation tool reruns it until it reports the row; a crash between (b) and (c) leaves `ceased_at` NULL, which blocks the drop and never permits it, and any later time is conservative. (d) The old key may be dropped once the database's `now() > ceased_at + 400 days + 1 day`; then its row is labelled `retired`. The day of margin covers a database clock step; there is no browser term. Cookies issued before this change carry a 30-day `Max-Age` and their rows' deadlines apply too.
  - (r10) **The deploy gate.** `alchemy.run.ts:85` binds one secret today (`SignIn.SessionSecret`). Step 1b replaces it with `SESSION_SECRETS`, a JSON map from key id to secret, and a gate that runs before the Worker is published. It reads `SELECT key_id, state, ceased_at, now() AS db_now FROM session_signing_keys` from the production database and refuses the deploy when: the issuer's key is not configured; or **any** key with a row is omitted from the configuration while `ceased_at IS NULL OR db_now <= ceased_at + interval '401 days'`, **whatever its `state`**, so a row already labelled `retired` is checked again and the label is never trusted. Only database time decides; the deploying machine's clock is not read.
  - **Compromise is a different procedure**, unchanged: dropping a compromised key at once makes its sessions read as signed out, which the fixed decision answers with a wipe.
  - Tests: a callback and an alias arrival paused before insertion across promotion (they insert under the new issuer; a pause past the issuance timeouts rolls back); an issuance transaction stalled while holding its row locks: promotion commits at once and the stalled transaction is terminated within 10 s; a renewal blocked behind a session-row update, and an uncommitted renewal, both across a session's expiry and across promotion: neither changes any cookie or the retirement time; the deploy refuses dropping a key before `ceased_at + 401 days`; two consecutive rotations. (r10) A **stalled promotion**: the promotion transaction holds its row update open (a test hook) while issuers insert under the old key, then commits; `ceased_at` is later than every K-stamped `started_at`, and the gate refuses at `ceased_at + 401 days - 1 s` and passes after. A **prematurely retired row** (labelled `retired` with a recent `ceased_at`, and one with NULL): the gate refuses. A **copied cookie** presented after its row's deadline, a **delayed** callback response delivered after it, and a browser clock set back 2 years: each reads as nobody. Every live predicate carries the deadline (the `SessionStore` listing test).
  - Short-lived purposes (`sign_in`, `handoff`, `run`) need only their own lifetimes.
  - Tests: a cookie signed under the previous key verifies until its row's deadline; the gate, not a count, decides the drop (r10).
- **Alert (detection only).** It fires when hourly `smithers_device_session_ends{trigger: ended}` exceeds 5× its 7-day baseline, with at least 50 events. A server-side `smithers_auth_session{outcome: cookie_rejected}` count (a cookie present but not verifying or resolving) uses the same rule and fires before devices act.

### 3.9 Sockets: viewer ticket and per-frame lease (Astra closed binding and freshness in round 4)

**Ticket.**
- **Issuing:** `POST /api/sockets/ticket` goes through `boundFetch` with the viewer header, and returns a `SessionKeys`-signed value for a new purpose, `"socket"`. It holds the actual session (alias or home), the parent, the host, the person, a ticket id and a 30-second expiry.
- **(r6) Audience and single use.** The ticket also carries `purpose` (`transcript`, `presence`, `coedit` or `terminal`) and its exact `destination`: the Durable Object name the route derives, such as the branch (`worker/BranchRooms.ts:134`) or the run (`worker/RunContent.ts:140`). The receiving object checks that purpose and destination name itself **before** it records the id. Only one object can accept a given ticket, so its consumed-id set makes the ticket single-use globally. The ticket's 30-second lifetime is separate from the session lease.
- **Admission:** the upgrade's resolved actor and session must match the ticket.
- **Rollout, server first.** The server accepts tickets but admits ticketless sockets, and counts them. The client then sends tickets. The server refuses ticketless sockets one release later. Until that refusal ships, older clients remain unbound, and the doc says so.

**Client.** `sealedSockets` replaces each local layer at its call site (`src/features/transcript/actions.ts:154`, `presence/actions.ts:108`, `coedit/store.ts:130-131`, `terminal/actions.ts:316`) and reads the latch.

**Lease.**
- **Window:** (r13) `leaseUntil = queryStartedLocal + min(60 s, expiresAt - dbNow)`, with `dbNow` the revalidation query's `clock_timestamp()` (the clock contract, section 5). Revision 12's `min(expiresAt, observedAt + 60 s)` compared Postgres's expiry with Worker time.
- **Revalidation:** elapsed results are discarded and the socket closes. Frames are held while a revalidation is pending. Revalidation checks both the alias and its parent, through `sessionLive` (r10, so the deadline applies), and a failed query closes the socket. (r11) An in-place re-authentication keeps the row, so a lease on it continues; a lease whose cookie key no longer matches closes and the client takes a new ticket under the new cookie. A socket close is never an end observation.
- **Where it is checked:** every send, every inbound frame, and every queued stdin application (`packages/smithers/flows/platform-cloudflare/src/ContainerTerminal.ts:681-686`).
- **Alarms** handle idle cleanup only, through one dispatcher with separate retention and revalidation deadlines. Integration waits for the verified hotfix, because `worker/RunContent.ts:106` is still retention-only.
- **Dependency:** step 3 depends on steps 2 and 2b for the socket protections it claims.

### 3.10 First paint: an uninterrupted lock hold (round 4 #4)

```
inline script (index.html, before #root and the module):
  no request if the mark is present or unreadable, or the route doesn't match
  navigator.locks.request("smithers-data", { mode: "shared" }, () => new Promise(r => (release = r)))
  once granted: re-read the mark (present -> release, stop)
  fetch first-paint (cookie, no-store) -> { viewer, expiresAt, serverNow, issue | list }; deadline from sentAt
  paint only if !revoked && mark absent && now < deadline && visible; textContent only
  revoke (remove node, drop seed and pending completion, release) on: a wipe-channel message, storage (mark present),
    pagehide, deadline, 30 s without hand-over; hidden or freeze hides the node; visible or resume rechecks first
hand-over: pageWipe.open({ held }) (src/wipe.ts:181-185, src/main.tsx:498)
  - held and the mark absent  -> the page adopts the shell's hold as its own `smithers-data` hold. There is no release
                                 and no gap. A later mark reaches the page as a wipe message, as for any running page.
  - held and the mark present -> the shell revokes first, then releases, and open() finishes the wipe as today
  - nothing held              -> today's path
```

The shell's private bytes are always inside one continuous shared hold, so a wipe cannot clear its mark while they exist. The seed is used only until the page's first session answer (viewer check) and its deadline. The test pauses between the shell's grant and the page's adoption while another tab wipes. No title appears.

### 3.11 What is lost, and authoritative counts (round 4 #6, #10)

**Lost on every end:**
- every unsent outbox write (`smithers-outbox`);
- every local store: drafts, `chat-unsent`, flow forms, file tabs, homes, pins pending and the rest of `src/device/registry.ts:47-171`;
- in-progress client runs;
- pending snapshots. These are stamped `owner:incarnation`. The incarnation is a new owner-record column, renewed at each claim, and boots clean stale keys. Astra closed this in round 4.

Synced rows come back on re-sync.

**Counts, computed once and deduplicated:**
- **Drafts.** The registry gains `draft: true` on draft stores. **(r6)** The leader runs `SELECT count(*)` over those tables in the same transaction that commits the revocation. It then serves no further statement from any tab (3.5). Statements admitted earlier have already committed, because SharedSqlite serializes them. (r7) `D` is taken in the **confirmed** revocation's transaction, whether the control-only leader or the replacement writer in `authorize` commits it (r8, 3.5.1). That transaction sets `wipe_confirmed`, after which no new-build activation can be admitted, P's own included (3.5). So no draft can be persisted between the count and the deletion. `D` is the final persisted set that the deletion destroys. Older cached builds ignore `wipe_confirmed` (3.3), so when one runs in between, the notice may undercount. Text only in the DOM was never saved. Step 7 writes `smithers-discarded-drafts = D`, and only the tab that writes the mark writes it.
- **Unsent writes.** The boot that finishes the wipe holds `smithers-data` exclusively before deleting (`src/wipe.ts:155-156`). It opens `smithers-outbox`, counts its records (`U`), then deletes.
- **The notice.** That boot writes `smithers-discarded = { drafts: D | null, unsent: U }`. The next page shows it once:
  - "N unsent changes and M saved drafts on this device were discarded";
  - when the ack never arrived: "N unsent changes and any saved drafts on this device were discarded".

  The notice names no person and no content.

### 3.12 The 400-day cap and re-authentication (r10, r11; effectscript-11)

**Rule.** A session lasts at most 400 days from its start, enforced by the server (3.8). From day 393 the page shows a non-blocking banner, "Sign in again to keep your session". Signing in again as the same person while the session is live renews **the same session row in place** for a fresh 400 days, with no wipe. Every other sign-in inserts a new row, and the device ends as it does today: after the deadline, revoked, another person, or no live cookie.

```
day 0          day 393                     day 400
 |--------------|---------------------------|
 sign-in        banner                      deadline: signed out, wiped
                 \-- banner sign-in, live cookie, same person --> same row: started_at = now(),
                     new GitHub token, cookie_key = issuer, cookie re-signed; no wipe
```

**Design twice (r11).** Revision 10 inserted a successor row that inherited a lineage, kept the old row for a 120 s grace and moved the aliases. Astra's round 10 found that revocation did not follow the lineage or the moved aliases (H1), that a parent's lineage could not prove an alias was continuous (H2), that the callback's existing sign-out flow ended the predecessor during OAuth (H3), and that the grace was not bounded in response deadlines (M5). Updating the row in place removes the lineage, the successor row, the grace and the alias move. Revocation stays a single-row update that ends the session and, through the parent join, every alias, as today (`worker/SessionStore.ts:284`). Chosen: in place.

**Server: the in-place re-authentication.**
- **Eligibility.** The callback verifies the session cookie it receives (`worker/SignIn.ts:716`) and records which key verified it. After the code exchange and `github.user`, one transaction locks that row `FOR UPDATE` and checks: (r12) the cookie verified under a configured key, **whichever** (a stale cookie qualifies, so a second callback after a re-key still renews), the row names the person GitHub just authenticated, `revoked_at IS NULL`, and the row is live at `clock_timestamp() + interval '30 seconds'` under both `expires_at` and its deadline. If all hold, it renews in place. Otherwise it inserts a new row and revokes the held one, as today (`:745-766`).
- **The update.** In the same statement that reads the issuer: `started_at = now()`, `expires_at = now() + maxAge`, `cookie_key = <issuer>`, the role and its generation from this sign-in, the new sealed `github_access` and `github_refresh`, and `github_token_gen = github_token_gen + 1`. The row's id and token stay the same.
- **The cookie.** The callback is a top-level navigation, not a session read, so setting the cookie there is sign-in's existing path and not round 5's overwrite. It sets a fresh cookie over the same token, signed by the current issuer, with `Expires` = the new deadline. When the issuer has not changed, the old cookie value is byte-identical in effect, so requests already in flight with it stay valid. (r12) When a rotation happened since the row was stamped, the renewal re-keys the row at commit, before the `Set-Cookie` reaches the browser (`worker/SignIn.ts:784-788`). Until it arrives, or if it never does, the browser's old cookie gets **credential stale**, below.
- **Token cleanup without ending the session (H3).** Today the callback starts `RevokeGitHubToken` for the held session before the code exchange (`:723`), and that flow begins with `EndSession` (`worker/flows/RevokeGitHubToken.ts:94`, `:172`). Revision 11 splits cleanup from termination:
  - The callback no longer starts that flow before the exchange. The in-place transaction moves the old sealed tokens into a new row of `github_token_cleanups (id, session_id, sealed_access, sealed_refresh, created_at)`, in the same transaction that writes the new tokens, so the cleanup is durable with the renewal.
  - After commit, the callback starts the new flow `auth/RevokeReplacedGitHubToken` with execution id `cleanup:<id>`. It opens the sealed tokens from the cleanup row, revokes them at GitHub, and deletes the cleanup row. It has no `EndSession` step, and it never reads or writes `sessions`. If the start fails, a sweeper on the existing alarm restarts it for rows older than 5 minutes.
  - The new-row path journals the held row's tokens the same way and revokes that row in its transaction, so it needs no flow before the exchange either. The sign-out flow `RevokeGitHubToken` keeps its execution id per session (`revokeExecutionId(sessionId)`) for real sign-outs, and `forgetTokens`' predicate (`:315-322`) is unchanged because it touches only ended rows.
- (r12) **`RecheckRole` is fenced by token generation in every write.** `RedeemRefresh` (`worker/flows/RecheckRole.ts:182-218`) records the row's `github_token_gen` beside the presented refresh digest, and the flow journals both with the redemption. Then:
  - `replaceTokens` (`worker/SessionStore.ts:361-379`) adds `AND github_token_gen = :gen` to its existing `github_refresh_digest = :presented` predicate;
  - `check`'s conditional revoke on a refused refresh (`RecheckRole.ts:238`) becomes `revokeIf(id, reason, gen)`: `WHERE id = :id AND revoked_at IS NULL AND github_token_gen = :gen`, so a refusal of the old refresh token never ends a renewed row;
  - `setRole` (`SessionStore.ts:385`) and `keepRole` (`:401`) add `AND github_token_gen = :gen` to their updates. A fenced role write that loses changes nothing; the renewal already wrote this sign-in's role.
- (r12, r13) **An unused redemption is revoked, not orphaned.** GitHub's refresh invalidates pair A and returns pair B. If a renewal (pair C) or a sign-out lands before B is stored, the fence rejects B, and today `store` returns `changed` (`RecheckRole.ts:221-227`) and B stays valid at GitHub. (r13) `store` classifies under the session row's lock, in one transaction, so it reads the latest committed row rather than a statement snapshot (round 12 finding 3: two overlapping attempts of the same journaled store, since `StoreTokens` retries without limit, `RecheckRole.ts:108`, could each start from A; the loser's plain `SELECT` still saw A and queued the installed B):

  ```
  BEGIN
  SELECT revoked_at, github_refresh_digest, github_pair_digest, github_token_gen
    FROM sessions WHERE id = :id FOR UPDATE
  -- installable: not revoked, github_refresh_digest = :presented, github_token_gen = :gen
  --   -> UPDATE sessions SET <B>, github_pair_digest = :pairDigest WHERE id = :id   (outcome stored)
  -- installed:   github_pair_digest = :pairDigest                     -> nothing     (outcome installed_replay)
  -- otherwise:   INSERT INTO github_token_cleanups (...) VALUES (... :pairDigest ...)
  --                ON CONFLICT (pair_digest) DO NOTHING                               (outcome abandoned_enqueued)
  COMMIT
  ```

  The renewal and the sign-out lock the same row (3.12 eligibility, `SessionStore.revoke`), so every classification sees whichever of them committed last. `pair_digest` is the SHA-256 of B's access token (a pair may have no refresh token), unique in `github_token_cleanups`; `sessions.github_pair_digest` records the installed pair's. An **installed replay** enqueues nothing. An **abandoned pair** (B lost to C or to a sign-out) is enqueued once, whatever the replay count, and `auth/RevokeReplacedGitHubToken` revokes it. A pair installed and later replaced by a renewal is enqueued by that renewal under the same `pair_digest`, so a late replay is a no-op. The flow starts the cleanup after `store` commits; the sweeper covers a crash between. Test (r13): two `store` attempts of the same journaled pair started concurrently from A (a barrier holds both after `BEGIN`): one installs B, the other classifies `installed_replay`, and `github_token_cleanups` stays empty; the same race with a renewal committing between them: B is enqueued exactly once.
- **(r12) Credential stale.** `GET /api/auth/session` answers `{ credential: "stale" }`, with no person, role or tag, when the cookie verifies under a configured key, the row it names is live (`sessionLive` without key equality), and the row's `cookie_key` differs from the verifying key. It names nobody and authenticates nothing; it only says the row is live. A cookie whose key was dropped no longer verifies and reads as signed out, so stale lasts at most until the drop (`ceased_at + 401 days`). Every other route refuses a stale cookie with 401 and `x-smithers-credential: stale`; the client's re-read after a 401 (3.1) then gets the stale answer.
- **(r13) The stale 401 never reaches a status handler.** Today `boundFetch` re-reads the session after a 401 and, when the re-read is not stale in its sense, returns the **original** 401 (`src/device/identity.ts:329-350`). Co-edit's outbox then classifies 401 as a permanent refusal and drops the update (`src/features/coedit/writes.ts:19`, `:74`). So a stale 401 whose re-read already sees the new cookie would drop an edit. Revision 13 consumes the header in `boundFetch`, the one transport every context uses: a response with `x-smithers-credential: stale` is never returned. `boundFetch` fails the request with `DeviceIdentityRefused({ reason: "credential_stale" })`, the same unsent outcome the `reauthorizing` path already uses, which every outbox treats as retry, not refusal. It then re-reads the session: a current-key answer for V under the same tag resolves at once, and the outbox's durable retry resends with the new cookie; a stale answer enters the hold below, and requests made during it wait in the hold's queue; the release lets the retry resend. Status handlers therefore see a stale 401 in no order. Tests: an edit answered `401/stale` whose re-read sees the new cookie: the edit is resent and stored, never counted `refused`; an edit answered `401/stale` whose re-read is stale: held, then released by the cookie's arrival, then resent and stored; the same for a worker-realm send.
- **(r13) A plain 401 drops an edit in production today.** Independent of this design: when a text write gets a 401 (for example, its cookie's session was ended by a sign-in in another tab of the same person between the send and the answer), `boundFetch`'s re-read sees the same person signed in, or signed out: `stale(...)` (`src/device/identity.ts:296-298`) is true only for a signed-in **other** person, so in both cases the original 401 is returned and co-edit drops the update as refused (`writes.ts:19`, `:74`). That loses typed text with no notice. Found by reading the code, not reproduced. It is a live defect, filed for its own fix and test outside this design: a 401 whose re-read names the bound person should be retried, and one whose re-read is signed out should leave the write queued for its owner, never refuse it.
- **(r12) The client on stale.** The realm enters the hold (below) without latching, sends no `{ revoke }`, and runs no confirmation. It re-reads the session after 1 s, then every 5 s, up to 60 s apart. It leaves the hold only on a current-key answer that names V under the same tag, which is a normal signed-in answer. While held for more than 10 s, it shows "Sign in again to continue", which starts the banner's sign-in; that callback renews the row (eligibility accepts a stale cookie) and sets a current cookie. A signed-out or other-tag answer during the hold is an end and latches at once (3.2). A 3.2 confirmation that gets stale counts as inconclusive: nothing is destroyed. (r13) A stale answer never renews anything: it carries no `expiresAt`, extends no permit and moves no deadline timer. It never overrides a latch: a latched realm stays latched whatever later answers say, and stale only keeps an unlatched realm in the hold. The leading worker treats stale from its own reads the same way, with its own hold.
- **Aliases (H2).** Alias rows hang off the same parent row, so a home re-authentication changes nothing for them. Each alias has its own deadline `least(h.started_at, s.started_at) + 400 days`, so it reaches day 393 by its own start and shows the banner on its host. The banner links to the hand-off with `reauth=1`. When the home session is within 7 days of its deadline, the hand-off runs the GitHub sign-in first, which renews the home row in place. The arrival then renews **the alias row this browser holds at this host** in place, under the same eligibility as the home callback (r13): locked `FOR UPDATE`, the cookie verified under **any** configured key (a stale alias cookie qualifies, so a lost `Set-Cookie` followed by another hand-off renews in place), the row's `host` equal to this host, the hand-off nonce verified as today, not revoked, live by its own deadline and its parent's, and the hand-off's session equal to its `parent_id`. It sets `started_at` and `cookie_key` and re-signs the same token. Otherwise it revokes the held alias and inserts a new one, as today (`worker/SignIn.ts:641-656`), and that alias host's device ends. (r13) Today's arrival verifies the held cookie with the current key only (`:641`); step 1b changes it to report the verifying configured key, as the callback does.
- **Concurrency (H1).** The renewal and every revocation update the same row, so the row lock orders them. A sign-out committed first makes the callback ineligible: a new row, and the device wipes. A renewal committed first is then ended by the sign-out, along with every alias. Two banner sign-ins at once both renew the row, whatever key each callback's cookie carries (r12); the second's update moves the first's new tokens into a cleanup row.
- **The answer.** `GET /api/auth/session` returns `deadline` and `session`, an opaque tag (the SHA-256 of the row id, truncated to 128 bits: the home row's, or the alias row's at an alias host), beside `expiresAt` and `serverNow`. An in-place renewal keeps the tag; any new row has a new one.

**Client.**
- **Banner.** Shown when `now + (serverNow - sentAt) >= deadline - 7 days`, in persisted and memory tabs alike; dismissible for the page's life; it starts sign-in with the current route as `returnTo`.
- **Continuation.** An answer naming V under the device's session tag continues the session (3.1). The tab sends `{ extend, tag }`; the leader extends the permit under `session_tag = :tag` and posts `{ deadline, gen }`; every realm re-arms its deadline timer (3.5). No provisional or confirmed revoke fires.
- **Deadline check with a reversible hold (M4).** A deadline timer is a local prediction. When it fires, or a realm resumes past it, the realm enters **hold**: every gate in 3.4 holds instead of closing. `boundFetch` queues new requests and withholds responses; `TabChannel` and `tabPort` queue posts; the collection coordinator queues publication; socket frames are held; host calls (`title.write`, `clipboard`, `web.openTab`, `navigate`, `reopenRoute`) are refused, not queued; the page sets `data-checking`, which hides content as `data-ended` does. The realm sends one unbound session read with a 5 s timeout. Then:
  - a **fresh, live** answer (dispatched after the hold began, not elapsed by its own `expiresAt`, 3.8) naming V under the same tag, with no `end:pending`, wipe message or revocation observed during the hold: re-arm, release the hold, and flush the queues;
  - signed out, another person or another tag: a confirmed end. Latch at once: the latch aborts every queued request, post and frame. 3.2 runs from step 1, and that read is step 6's confirmation input only if it was sent after the latch; otherwise step 6 sends its own;
  - (r13) **credential stale**: stay in the reversible hold and poll as above (1 s, then 5 s, up to 60 s apart), unbound. Do not latch, revoke or confirm. Release only on a current-key answer naming V under the same tag; a signed-out or other-tag answer latches. Neither stale nor a poll's timeout confirms destruction;
  - no answer in 5 s, a 5xx, or a message showing an end: latch, and 3.2 runs from step 1 with its own confirmation. The hold never stands in for a confirmation and never skips a wipe.
- Every realm that holds a deadline runs its own check: each tab, and the leading worker with its own hold. The realms' timers fire at the same server deadline.

**Races.**

| Race | Outcome |
|---|---|
| Banner sign-in, then a sign-out that carried the same cookie | The row lock orders them. Renewal first: the sign-out ends the row and every alias, and devices wipe. Sign-out first: the callback is ineligible, a new row, the device wipes. |
| Re-authentication after the deadline, or with its eligibility check within 30 s of it | Ineligible: a new row and a new tag. Realms held at the deadline get signed out (or the new tag once the new cookie lands) and latch; the confirmation wipes with counts. |
| Re-authentication by another person Q | Ineligible: a new row; answers name Q; the device wipes. |
| Several tabs mid-flight while the cookie is reset | With no rotation since the row was stamped, the old cookie still verifies, so in-flight requests answer V under the same tag. Later requests carry the new cookie, same tag. No revoke fires. |
| (r12) The same across a key rotation, or the callback's response delayed or lost | The renewal re-keys the row at commit. Until `Set-Cookie` arrives, every tab's old cookie gets **credential stale**: each realm holds, sends no `{ revoke }` and confirms nothing. The first current-key answer releases them. If the response is lost, the hold persists, the page offers "Sign in again to continue", and that callback renews the row and sets the cookie. No wipe in any order. |
| (r12) Two callbacks across a rotation, the second carrying the old-key cookie | Eligibility accepts any configured key, so the second also renews in place; the first's tokens go to cleanup. The browser keeps the last cookie, signed by the current key. |
| A tab's timer fires at the old deadline before `{ deadline }` reaches it | The hold's check gets V, same tag, new deadline: release. |
| Alias expired, then a hand-off creates a new alias while the alias tab is frozen (round 10 H2) | The held alias was not live, so the arrival inserts a new row with a new tag. On thaw the hold's check sees another tag: latch, and the device wipes. |
| Token cleanup running before, during or after the callback | It touches only `github_token_cleanups` and GitHub; the session row stays live throughout. |
| An older client (no tag) | It compares the person only, as revision 9 did. Older clients are already named limits (3.3). |

**Retirement is unchanged.** Key equality ties every accepted cookie to its row's current `cookie_key`, and `started_at` moves only together with it, so the 3.8 proof covers in-place renewal.

**Tests (r11):**
- banner sign-in on day 394 with two other tabs open, one with a session read in flight on the old cookie: no `{ revoke }`, the tag unchanged, the in-flight answer names V, every realm re-arms;
- (r12) after a key rotation, the callback's response held for 30 s before `Set-Cookie` reaches the browser: another tab's session read and its 401 re-read get `stale`, it holds, sends no `{ revoke }`, and releases when the cookie lands; the same with the response dropped: the hold persists, "Sign in again to continue" renews in place, nothing is wiped; a signed-out answer arriving during that hold (a sign-out elsewhere) latches and wipes;
- (r12) two callbacks across a rotation, the second carrying the old-key cookie: both renew in place, one row, two cleanup rows;
- (r13) an alias renewed across a rotation with its `Set-Cookie` lost, then another hand-off with the old alias cookie: the arrival renews the same alias row, the tag is unchanged, and nothing is wiped; the same with the alias revoked first: a new row and a wipe;
- (r13) the deadline check getting `stale`: the realm stays held and polls, sends no `{ revoke }`, and releases on the cookie's arrival; a latched realm that later gets `stale` stays latched;
- (r12) a stale cookie after its key's drop reads as signed out; a stale answer names no person, role or tag;
- (r12) `RecheckRole`: refresh A redeems into B, a renewal installs C, the fenced `store` enqueues B once and the cleanup revokes it; crash after the redemption is journaled and before `store` (replay enqueues B once); crash after `store` installed B and before the flow records it (replay finds `github_pair_digest = B`, enqueues nothing); B installed, then replaced by a renewal, then a late replay (no second row); a refused refresh after a renewal does not revoke the row; `setRole` and `keepRole` with a stale generation change nothing;
- sign-out with the same cookie racing the callback, in both commit orders: the row and its aliases end in both;
- two simultaneous banner sign-ins: one row, two cleanup rows, both old token pairs revoked;
- token cleanup started before the callback commits (a cleanup row left by an earlier renewal), while it runs (the flow paused mid-revoke), and after it: the session stays live and answers V under the same tag each time; `RecheckRole` refreshing the old token across the renewal does not overwrite the new one;
- eligibility 29 s before the deadline, and a callback finishing after it: a new row and a wipe;
- Q signs in on day 394: wipe;
- an alias host on day 394: `reauth=1` renews home in place, then the alias in place, and no device wipes; an alias whose own row expired before the hand-off, with its tab frozen: a new tag on thaw, latch and wipe;
- the hold: a queued title write, clipboard write, worker call, coordinator publication and socket frame during a stalled check are not emitted, and are flushed (or, for host calls, dropped) only on a fresh live answer; a signed-out answer during the hold latches at once and aborts the queues; a 5 s timeout latches; an answer older than its own `expiresAt` does not release the hold;
- the banner at day 393 by server time with the device clock 3 days off;
- key equality: a cookie signed by a previous key for a row re-stamped with the current key authenticates nobody and answers `stale` (r12).

## 4. Coverage

- **On disk.** Deleting the whole directory and database covers:
  - the 23 local and 31 synced registry stores;
  - `timeline-summaries` and `device_kept`;
  - Electric resume state;
  - the owner record, with its permit and incarnation;
  - engine history;
  - the outbox.
- **Treated separately:**
  - pending snapshots (incarnation stamp);
  - both RPC systems and every `TabChannel` instance (the latch);
  - the collection coordinator's BroadcastChannel (dispose on latch);
  - worker factories and instances;
  - the worker's own latch and its prestarted read (the recheck at `authorize` commit);
  - sockets (ticket, client gate, server lease);
  - the first-paint shell (continuous lock);
  - host outward calls;
  - buffered response bytes (retained heap);
  - localStorage keys (`smithers-wipe`, `smithers-discarded*` and the reload reason), none of which identifies a person;
  - Cache Storage, which never holds `/api/` (`src/pwa.ts:60-66`, `vite.config.ts:84-94`).

## 5. Rollout

| Step | Ships | State |
|---|---|---|
| 0 | `repositoryReadable` proof | may start |
| 1 | `expiresAt` and `serverNow`, parent expiry for aliases | landed: `a647e896b665`, `66193380b599` (r13); see the skew caveat below |
| 1b | renewal; cookies set only at sign-in; (r10) the server-enforced 400-day deadline in `sessionLive`, `deadline` in the answer; (r11) `started_at`, key equality, the session tag, (r12) the `stale` answer and header, the generation fence on every `RecheckRole` write, the abandoned-pair enqueue, in-place re-authentication at the callback and the arrival, `github_token_cleanups` with `auth/RevokeReplacedGitHubToken` and its sweeper, `github_token_gen` on `RecheckRole`, the `reauth=1` hand-off; a separate `SESSION_SEAL_SECRET`; `SESSION_SECRETS`, the issuer from durable key state, `ceased_at` read after the promotion commits, and the deploy gate (r10); bounded issuance transactions; the `@anonymous` binding; `cookie_rejected` and the alert | additive work may start; ships before step 3; no key may be dropped before its `ceased_at + 401 days` by database time, enforced by the deploy gate |
| 2 | socket ticket (accepted, not required), atomic single-use, proof, per-frame lease; dispatcher after the hotfix is verified | may start |
| 2b | client tickets, then server enforcement | after 2 |
| 3 | **one client release:** (r11) the banner, session-tag continuation, the deadline check under the reversible hold, and (r10) the recovery worker; latch and gates, revocation and confirmation, SQLite permit, worker latch, `authorize` outcomes, memory-tab contract, lifecycle handlers, counts, snapshot incarnation; (r8) the control-only leader and replacement writer (3.5.1) and `SqlConnection.quiesce` in the SDK (3.5.2) | after 1, 1b, 2b and Astra |
| 4 | first paint with lock transfer | after 0 and 3 |
| 5 | actions, compare and home on the proof | landed: `dcd4a30fea25`, `cba6fdf27e8c` (r13) |
| 6 | follower eviction | investigation only |

**(r13) The clock contract (Astra round 13; step 1's skew caveat).** Step 1 samples `serverNow` from the Worker's clock (`worker/SignIn.ts:926`), while `expiresAt`, liveness and renewal use Postgres's time. A Worker clock behind Postgres overstates the remaining lifetime by the skew. Step 1b replaces it with this contract, and no enforcement step trusts `expiresAt` before it ships:

- **One clock.** The lookup that reads a session's effective `expiresAt` and absolute `deadline` also returns `clock_timestamp()` as `serverNow`, sampled in the same request and **after** any renewal in it. `now()` is not used for the sample, because it is the transaction's start and could belong to an earlier statement.
- **Carried through.** `serverNow` travels `Live -> Signed -> response` with the expiry it was sampled beside. Worker time never replaces it.
- **Client deadlines.** `deadline_local = sentAt + (expiresAt - serverNow)`, where `sentAt` is the local time the request was sent. A fixed browser-clock offset cancels, and a delayed answer only makes the deadline earlier.
- **Socket lease (3.9).** `leaseUntil = queryStartedLocal + min(60 s, expiresAt - dbNow)`, where `dbNow` is the revalidation query's own `clock_timestamp()` and `queryStartedLocal` the Worker's local time when that query started. Raw Postgres expiry is never compared with Worker time.
- **Tests:** Worker clock ahead of and behind Postgres, for home and alias sessions; renewal in the same request (the sample is after it); a delayed answer (the local deadline moves earlier, never later); a socket lease with a skewed Worker clock expiring at the database's time. Step 1's skew test (`worker/SignIn.test.ts:322`) pins the defect and is replaced by these.

**(r13) Implementation notes from Astra round 13.** The stale-header interception in `boundFetch` goes **before** the `reauthorize === undefined` return (`src/device/identity.ts:330`), because the engine worker binds with no `reauthorize` (`src/flows/engine.worker.ts:83`); the worker test is required. The alias arrival's unconditional revoke of the held alias (`worker/SignIn.ts:647`) is replaced by the 3.12 eligibility check.

Migration: additive owner-record columns `permit_until`, `permit_gen`, `incarnation` and `wipe_confirmed` (r7). On the server, `cookie_key` is added to `sessions` and `host_sessions`, and (r8) the `session_signing_keys` table is created with the current key as `issuer` (r10: with `promoted_at` and `ceased_at`). (r11) `sessions` and `host_sessions` gain `started_at timestamptz NOT NULL` (backfilled from `created_at`); `sessions` gains `github_token_gen integer NOT NULL DEFAULT 0` and (r12) `github_pair_digest text NULL`; the table `github_token_cleanups` is created with (r12) a unique `pair_digest`. The owner record gains `session_tag`, which a NULL record adopts at its next verified activation. Cookies issued before this change keep their 30-day lifetime. No device data is migrated. Offline access returns after one online activation. Decision 0023 rule 2 is superseded.

## 6. Metrics (no person, login, ticket, key or URL)

- `smithers_device_session_ends{trigger, detector, scope, confirmation: confirmed | superseded | inconclusive}`
- `smithers_web_device_wipes{outcome}`
- `smithers_device_discarded{kind: drafts | unsent}`, recorded as counts
- `smithers_device_permit{op: issue | extend | revoke, outcome: committed | stale}`
- identity outcomes `ended`, `replaced` and `refused_offline`
- `smithers_device_end_fenced{layer}`
- `smithers_session_renewals{outcome}`
- `smithers_auth_session{outcome: cookie_rejected}`
- (r8) `smithers_auth_issue{outcome: issued | issuer_unconfigured}`
- (r9) `smithers_device_revoke_watchdog{cause: quiesce_timeout | rollback_failed | no_ack}` and `smithers_device_pending_committed{kind: provisional | confirmed}`
- (r8) `smithers_device_revoke_control{state: revoking | control_only | closed, exit: confirmed | observer_released | lock_lost}` and `smithers_device_quiesce{rolled_back: owner | none}`
- (r11) `smithers_auth_reauth{outcome: renewed_in_place | new_row, reason}`, `smithers_auth_token_cleanup{outcome: revoked | retried | failed}`, `smithers_auth_session{outcome: past_deadline | stale}`, (r12) `smithers_auth_token_store{outcome: stored | installed_replay | abandoned_enqueued}`, (r13) `smithers_device_transport{outcome: credential_stale}`, `smithers_device_stale_hold{outcome: released | ended | reauth}`, `smithers_device_deadline_check{outcome: released | ended | timeout}`, `smithers_device_recovery_worker{outcome: committed | control_only | lock_lost}` and `smithers_deploy_key_gate{outcome: passed | refused}`
- `smithers_device_principal_refusals{outcome: anonymous}` (the existing counter, with a new outcome)
- `smithers_socket_tickets{outcome}` and `smithers_socket_lease{host, outcome}`
- first-paint outcomes, plus `guard_revoked`, `deadline_removed`, `ttl_removed` and `lock_adopted`

Each name goes into `src/telemetry-privacy.test.ts` and `src/features/auth/contract.ts:220-227`.

## 7. Tests (additions)

**Unit:**
- **Permit:**
  - the revoke bumps the generation, so a stale extension or issue does nothing;
  - a stale activation refuses;
  - offline refuses with no row, NULL or past;
  - a delayed verified answer that is already past its time refuses.
- **Confirmation:** superseded and inconclusive destroy nothing; confirmed wipes.
- **Worker:** when it observes an end and a tab's confirmation then verifies, the next activation issues a new permit and nothing is wiped.
- **Latch:** each gate in 3.4, including a `TabChannel` created by `SharedSqlite` and `BrowserRuntime`, and coordinator dispose with a transaction held.
- **(r6) Raw send boundaries:** the raw worker-call and tab-reply sends (`src/flows/tabPort.ts:76`, `:156`).
- **(r6) Permit:** a revoke that lands between the prestarted read and `authorize` does not come back; a stale provisional revoke is ignored.
- **(r6) Leader after revocation:** it refuses statements.
- **(r6) Binding:** `@anonymous` with a Q cookie gets nobody.
- **(r6) Cookies:** only sign-in and sign-out set the cookie, so a delayed session response sets none.
- **(r6) Tickets:** a ticket presented to a second destination is refused.
- **Memory tab:** requests are held until the viewer is fixed; expiry and Q to R.
- **Server, keys and cookies:**
  - an alias whose parent another host renewed stays live;
  - key rotation through retirement, with a non-expiring token;
  - (r10) the deploy gate refuses an early drop by database time, including a row labelled `retired`; a stalled promotion; a copied cookie past its deadline reads as nobody;
  - single-use ticket consumption under concurrent upgrades.
- **Counts:** `D` comes from the ack transaction; `U` comes from the deleting boot.

- **(r8) Control lifecycle (3.5.1):** delayed confirmation reaches the control-only leader; leader gone plus failed mark write: the replacement writer commits `wipe_confirmed`; offline next boot refuses without destroying; superseded exit.
- **(r8) `quiesce` (3.5.2):** a frozen follower's open transaction is rolled back and its later `COMMIT` fails; a statement running at `quiesce` completes and nothing else is admitted; the control owner keeps running statements.
- **(r8) Keys (3.8):** a callback and an alias arrival paused before insertion across promotion.
- **(r9) Pending first:** leader lost, mark write failed and the owner re-signed in, together (3.5.1).
- **(r9) Watchdog:** hung `step()` during `quiesce`; failed `ROLLBACK`; a blocked worker event loop; each separate from frozen tabs (3.5.2).
- **(r9) Keys:** stalled issuance holder; blocked and uncommitted renewals across expiry and promotion; deploy refuses an early drop; `Expires` on new cookies (3.8).
- **(r11) Re-authentication (3.12):** in-place renewal with tabs mid-flight, with and without a rotation; (r12) a delayed and a lost callback response across a rotation (stale hold, no wipe); two callbacks across a rotation; `RecheckRole`'s abandoned pair and its crash points; sign-out racing the callback in both orders; two simultaneous callbacks; token cleanup before, during and after the callback never ends the session; `RecheckRole` across a renewal; after the deadline; another person; alias in-place renewal and an expired alias with a frozen tab; the reversible hold; key equality.
- **(r10) Recovery worker (3.5.2):** exactly one tab, hung leader, kill, recovery commits provisional then confirmed; its module graph.
- **(r8) Web Locks wording:** an activation already holding `smithers-admit` shared when an end is observed (3.6).

**Playwright:**
- an end while the leader's tab is frozen, with the observer kept open: retry, then commit on resume;
- (r8) an end while a follower holds an open transaction and is frozen: the revocation commits without it;
- a pre-wipe offline boot on an updated device refuses until online;
- inconclusive confirmation (503), then an offline boot: refused, data intact; then online and signed out: wiped;
- P re-signs in from the banner (in place) while another tab's stale end is pending: no wipe; (r10) P re-signs in after the old session ended: wipe;
- (r10) real OPFS: the leader's worker terminated right before the revocation's `COMMIT`, and after `COMMIT` before the ack;
- (r11) day 394 banner sign-in across three tabs and an alias host: no revoke, no wipe; a stalled deadline check emits no title, clipboard or publication;
- a pause between shell grant and page adoption during another tab's wipe: no title;
- a held collection transaction across the latch: no broadcast on the coordinator channel;
- the discarded notice, with and without the ack.

## 8. Risks, open questions, not guaranteed

**Risks:**
- A false signed-out answer is now confirmed before it destroys anything. A rotation is protected by overlapping signing keys and the pinned encryption secret, and the alert detects the rest.
- Offline access after updating needs one online activation.
- A frozen holder blocks deletion and new boots, as with sign-out today. After 3 s the waiting page shows "Finishing sign-out. Close other Smithers tabs."
- (r10) **Day 400.** A person who ignores the banner for seven days is signed out at day 400 even while active, and the device's unsent changes and drafts are wiped, with counts. Browsers may drop cookies sooner than 400 days; that only brings the sign-out and wipe earlier and never weakens key retirement.
- (r11) An in-place renewal keeps the token, so a copied cookie for a live row stays valid until the row ends, as any session cookie does today; signing out ends it.
- (r12) A browser whose callback response was lost after a re-key stays held, with no private access, until it signs in again or the old key is dropped; it is never wiped for that alone. A redemption lost between GitHub's refresh and the flow's journal (a crash inside `RedeemRefresh`) is not revocable, as today.

**Open questions:** the hotfix dispatcher integration; step 6's coordinator truncate.

**Not guaranteed:**
- pixels in hung or frozen renderers, and OS snapshots;
- running older tabs (revoked only when they release) and older cached boots (they open offline);
- unobserved ends (sockets learn within one lease);
- old clients' sockets before ticket enforcement;
- buffered heap;
- the 3.6 residual: no committable leader, and the observer closed, before an offline boot;
- the 3.2 ordering residual, narrowed: memory-runtime state from a re-sign-in during a pending confirmed wipe (data loss only);
- a delayed sign-out response expiring a newer sign-in's cookie, which leads to a sign-out and a wipe (r7, 3.8);
- an older cached build that ignores `wipe_confirmed` (r7);
- a clock set backwards extends the offline permit (the server's deadline is unaffected);
- forensic access before deletion, devtools, same-origin script, URL and history, and first-paint timing.

**Lost by design:** unsent writes, drafts and client runs, with counts shown.

## 9. Draft decision record

File: `apps/mvp/docs/decisions/NNNN-every-session-end-wipes-the-device.md`. The number is assigned at land.

```markdown
# NNNN · Every session end wipes the device

2026-11-02 · Accepted. Supersedes [0023](0023-device-ownership-and-queued-authority.md) rule 2. Expiry, revocation and a person change left open pages rendering the previous person's content, and an offline reload could reopen it.

## Rule

Sessions last 29–30 days after the last session read, and at most 400 days after sign-in, enforced by the server. From day 393 a banner asks the person to sign in again; doing so as the same person with a live cookie renews the same session row in place for a fresh 400 days, with no wipe. Any other sign-in creates a new session, and the device ends. When a tab or worker observes its owner's session end, it revokes every outward path of its realm in that task and asks the leading worker to revoke the device's offline permit, which lives in the owner record and changes only through generation-checked statements. A session read sent afterwards confirms the end before the device runs sign-out's wipe; an unconfirmed end refuses without destroying. A device opens offline only with an unrevoked, unexpired permit, issued by a verified activation. While an observed end awaits durable revocation, the observer's exclusive admission lock, once granted, blocks every activation in the origin; the leader that revoked stays a control-only writer until the outcome is final, and every later leader commits pending revocations, confirmed ones first, before it asks for admission; a stuck leader's worker is terminated by its tab and replaced, by a latch-exempt recovery worker that can only commit revocations when the tab is latched. A confirmed end is recorded in the device database and blocks every activation until the deletion completes. Unsent writes and drafts are discarded and their counts shown. Memory tabs fix their viewer and deadline from their own session answer before accepting authenticated responses. A tab with no viewer is bound as `@anonymous`, so it never receives a signed-in person's data. Issuing a permit takes a session read dispatched after the latest revocation.

## Consequences

No recovery protocol exists. Offline use needs one online activation after updating. Session cookies are set only at sign-in and sign-out. The server decides liveness from the sliding expiry and the 400-day deadline, never from the cookie's own expiry. At day 400 a person who has not signed in again is signed out even while active, and the device's unsent changes and drafts are wiped with counts shown. The signing key rotates with overlap; the issuer is chosen inside the session's insert from durable key state, cessation is read from the database clock after promotion commits, and an old key is dropped only when the database's time passes cessation + 401 days, which the deploy checks for every omitted key. The encryption secret is pinned. Sockets need a single-use viewer ticket and hold a per-frame lease.

## Rejected

Seal and keep, and a 24-hour outbox exception (four review rounds found freshness, recovery and retention races in every keep-something protocol); an absent-permit migration exception (it cannot tell unmigrated from revoked); a localStorage permit (its read-modify-write is unordered across tabs); a socket subprotocol; retiring keys by the browser's cookie expiry (clock changes, delayed and copied cookies defeat it); treating any same-person sign-in as a continuation (a sign-out elsewhere would then never wipe); a successor session with an inherited lineage and a grace window (revocation did not follow it, and aliases could not prove continuity).
```

## 10. Changelog

### Round 12 (revision 12 to 13)

| # | Finding | Resolution |
|---|---|---|
| 1 H | Alias arrival still requires the cookie's key to equal `cookie_key` (`SignIn.ts:641`), so a lost alias `Set-Cookie` followed by another hand-off wipes | Arrival takes the callback's configured-key eligibility and keeps the live-row, host, nonce and parent checks. Test: lost delivery, then another hand-off, renews in place. (3.12) |
| 2 H | `boundFetch` returns the original stale 401 (`identity.ts:329`, `:350`), and co-edit drops a 401 for good (`writes.ts:19`, `:74`) | `boundFetch` consumes `x-smithers-credential: stale`, never returns that response, and fails the request as unsent (`credential_stale`), which outboxes retry; an immediate current-key re-read resolves and the durable retry resends; a stale re-read holds and the release resends. Tests for both. A plain 401 whose re-read names the same person also drops an edit in production today: recorded as a separate live defect. (3.12) |
| 3 M | The cleanup CTE can queue the installed pair when a retry overlaps (READ COMMITTED snapshots) | `store` classifies under `SELECT ... FOR UPDATE` on the session row in one transaction: install, installed replay, or enqueue. Test: overlapping stores of the same journaled pair, with and without a renewal between. (3.12) |
| Round 13 M | The clock correction lacked a contract | `serverNow` = `clock_timestamp()` in the same lookup, after renewal, carried `Live -> Signed -> response`; client deadline `sentAt + (expiresAt - serverNow)`; lease `queryStartedLocal + min(60 s, expiresAt - dbNow)`; tests for both skew directions, home and alias, renewal, delayed answers and socket expiry, replacing `SignIn.test.ts:322`. (3.9, 5) |
| Note | Deadline outcomes omitted stale | Added: stale continues the reversible hold and polls; it never latches, renews expiry or overrides a latch. (3.12) |
| Step 1 | Astra's skew caveat | `serverNow` is the Worker's clock, the end is Postgres's. Enforcement must not trust `expiresAt` until the skew is resolved or bounded, for example `serverNow` from Postgres's `now()` in the same query. Step 1 landed with a test pinning the skew pass-through. (5) |

### Round 11 (revision 11 to 12)

| # | Finding | Resolution |
|---|---|---|
| 1 H | A re-keying renewal invalidates the old cookie before `Set-Cookie` arrives, so another tab confirms signed out and wipes; two callbacks across a rotation conflict | A third answer, **credential stale**: a cookie validly signed by a configured key, for a live row stamped with another key. It names nobody and authenticates nothing. The client holds (3.12's reversible hold), sends no revoke, confirms nothing, and resumes only on a current-key answer; a lost response leads to "Sign in again to continue". A 3.2 confirmation that gets stale is inconclusive. The callback renews whenever the row is live and the person matches, whatever the cookie's key. Tests: delayed and lost callback responses, two callbacks across a rotation. (3.1, 3.2, 3.8, 3.12) |
| 2 M | `RecheckRole` redeems A into B, a renewal installs C, the fence rejects B, and B is never revoked | `store` is one statement: the fenced update, or else an idempotent insert of B into `github_token_cleanups` keyed by a unique `pair_digest`. `sessions.github_pair_digest` tells an installed replay (enqueue nothing) from an abandoned pair (enqueue once). Crash tests before and after `store`. (3.12) |
| Note | Fence every `RecheckRole` write literally | `replaceTokens`, the conditional revoke (`RecheckRole.ts:238`), `setRole` and `keepRole` (`SessionStore.ts:385`, `:401`) all require the observed `github_token_gen`. (3.12) |

### Round 10 (revision 10 to 11)

| # | Finding | Resolution |
|---|---|---|
| 1 H | Revocation does not follow a continued lineage or its moved aliases | No lineage and no successor row: the banner sign-in renews the same row in place. Revocation still updates one row and ends its aliases through the parent join; the row lock orders it against renewal. Test: both commit orders. (3.12) |
| 2 H | A parent's lineage cannot prove an alias was continuous | Aliases are not moved. Each alias renews in place at its own host, only if the held alias row is live and locked; an expired or revoked alias gets a new row and a new tag, and that device wipes. Test: an expired alias with a frozen tab. (3.12) |
| 3 H | The callback's `startSignOut` (`SignIn.ts:723`) runs `EndSession` and kills the predecessor | Cleanup is split from termination: old tokens go into `github_token_cleanups` in the renewal's transaction, and `auth/RevokeReplacedGitHubToken` (no `EndSession`, never touches `sessions`) revokes them after commit, with a sweeper. `RecheckRole` writes are fenced by `github_token_gen`. Test: cleanup before, during and after the callback never ends the session. (3.12) |
| 4 M | The 5 s check hides content but leaves private outward paths active | A reversible hold on every 3.4 gate: requests, posts, publication and frames queue; host calls are refused; release only on a fresh, live, same-tag answer with no end seen; a confirmed end latches at once; a timeout latches. The hold never skips a wipe. (3.4, 3.12) |
| 5 M | The 120 s grace is not bounded in response deadlines | The grace is gone. Every answer's `expiresAt` is the row's earliest known end, and an elapsed answer is rejected before admission, extension or release. (3.8) |
| Design twice | Successor row with lineage vs in-place renewal | In place: it deletes lineage, the grace, the alias move and the sign-out-before-exchange step. Retirement holds through key equality: a cookie authenticates only when its key equals the row's `cookie_key`, which moves only together with `started_at`. Cost: an in-flight request across a renewal after a key rotation gets one superseded provisional revoke, named in section 8. |

### Round 9 (revision 9 to 10)

| # | Finding | Resolution |
|---|---|---|
| 1 H | The browser's cookie expiry is no server deadline: clock changes, delayed responses and copied cookies | The 400-day deadline is enforced by the server: `created_at` (and `cookie_key`) stamped at insert, `created_at + 400 days` in one `sessionLive` fragment used by every live predicate, aliases bounded by `least(own, parent)`, a `Live` in memory carrying its deadline, and `deadline` returned to clients. `Expires` stays as hygiene only. Tests: copied cookie past the deadline, a delayed callback response, a client clock 2 years back, and a listing test for every live predicate. (3.8) |
| 2 M | `demoted_at = now()` is the promotion's start, so a stalled promotion makes it early; the deploy gate is unspecified; `alchemy.run.ts:85` binds one secret | `ceased_at = clock_timestamp()` is recorded in a separate statement after the promotion commits; a crash in between leaves NULL, which blocks the drop. A drop needs the database's `now() > ceased_at + 400 days + 1 day`. `SESSION_SECRETS` replaces the single secret, and the gate refuses any omitted key whose `ceased_at` is NULL or too recent by database time, whatever its `state`. Tests: stalled promotion; prematurely retired rows (recent and NULL `ceased_at`). (3.8, 5) |
| 3 M | The watchdog's replacement worker is forbidden by the latch (the revision-9 latch table, `main.tsx:393`) | A latch-exempt `Revocation.recoveryWorker()`, started only by a latched realm with a pending revocation and no live leader: it takes the engine lock and commits pending requests, then is control-only. Its module graph has no engine, collection, fetch, socket or channel, and it reads no session. The observer's document keeps its barrier and resends across the kill. Test with exactly one tab. (3.4, 3.5.2) |
| Note | "Hot journal rollback" was wrong | WAL with `synchronous = FULL` (`BrowserSqlite.ts:301`): a committed revocation is durable in the WAL; a killed transaction's uncommitted frames are ignored by WAL recovery. Real OPFS termination tests before `COMMIT` and after `COMMIT` before the ack. (3.5.2) |
| Day 400 | Draft and outbox loss at the cap was not disclosed | Disclosed in the summary, section 8 and the decision record. effectscript-11 then decided the cap plus a banner from day 393 and a same-person re-authentication with no wipe (3.12). |
| effectscript-11 | 400-day cap, banner, re-authentication continues | Sessions carry a lineage. A re-authentication inherits it only when the old row is live and names the same person at the insert's last statement (with 30 s margin); the old row gets a 120 s grace and its aliases are re-parented. The device continues on the same person in the same lineage, extends the permit and re-arms every tab's timer; a deadline timer first runs a 5 s check read. Re-auth after the deadline or by another person wipes. Narrowing: a confirmation now supersedes only within the lineage, so sign-out elsewhere followed by a new sign-in wipes. Tests for each race. (3.1, 3.2, 3.5, 3.12) |
| Simplest choice | Session-id continuity, client-side time comparison, or a server lineage | A server lineage: the server decides continuity in the one transaction that sees both rows, so the device compares two strings and needs no clock. Session-id continuity would wipe on every re-auth; a client-side start-versus-deadline comparison would call a sign-out elsewhere a continuation. |

### Round 8 (revision 8 to 9)

| # | Finding | Resolution |
|---|---|---|
| 1 H | The replacement writer deadlocks when the leader is lost, the mark write failed and the owner re-signed in | Every elected writer subscribes to the identity channel first in `authorize` and commits pending provisional and confirmed requests before its own session read and before it asks for admission, whatever its own answer. A confirmed request ends `authorize` with `wipe_pending`. Test: all three conditions together. (3.5, 3.5.1) |
| 2 H | Retirement races a renewal that crosses expiry (`now()` is the transaction start) | **Design twice.** Re-signing at renewal was rejected (it reintroduces round 5 #4 and still counts racy rows). Chosen: cookies get an absolute 400-day `Expires`, are never re-signed, and an old key is dropped only `demoted_at + 401 days` after it stopped issuing. Retirement reads no session row, so renewals and aliases cannot race it; the count is gone. The deploy refuses an early drop. Tests: blocked and uncommitted renewals across expiry and promotion. (3.8) |
| 3 M | `quiesce` can hang on a `step()` that never settles, or poison the connection | Failure transitions and an external watchdog: the worker or its hosting tab detects a 5 s `quiesce` timeout, a poisoned rollback or a missing 10 s ack; the tab terminates the worker, which releases the engine lock and OPFS handles; the next leader opens afresh (SQLite rolls back the hot journal) and commits pending requests first. The observer's barrier holds throughout. Tests for hung execution, rollback failure and a blocked event loop, apart from frozen tabs. (3.5.2) |
| 4 M | Promotion waits on `FOR SHARE` holders with no deadline | Removed with the time-based retirement: issuers read the key row without locking it. Issuance transactions get server-enforced `statement_timeout` 5 s, `lock_timeout` 2 s and `idle_in_transaction_session_timeout` 10 s and one lock order (`people`, then the session table); promotion runs with `lock_timeout` 2 s and retries. Test: a stalled holder does not block promotion and is terminated within 10 s. (3.8) |
| Simplest choice | Fence renewals and keep counting, or bound by cookie lifetime | The cookie-lifetime bound needs no renewal fence, no count, no row lock and no alias join, at the cost of a 401-day verifying overlap that the fixed decision already accepts. |

### Round 7 (revision 7 to 8)

| # | Finding | Resolution |
|---|---|---|
| 1 H | After a provisional revoke the leader closes, so nothing commits `wipe_confirmed` | The leader stays a **control-only writer** after the provisional ack (engine lock held, connection quiesced, only revoke messages served) until the confirmed revoke commits, or its shared `smithers-admit` request is granted (observer released or gone), or it loses the engine lock. If it is gone, the next leader's `authorize` is the **replacement writer**: its fresh read confirms `ended`/`replaced` and commits the confirmed revocation before admission. States, retry and exits in 3.5.1; tests for delayed confirmation, a lost leader with a failed mark write, an offline next boot, and supersession. |
| 2 H | Key retirement races an issuer that captured key K before insertion | The issuer is chosen **inside** the session/alias insert from `session_signing_keys` (`FOR SHARE`), and the cookie is signed after commit with the recorded key. Promotion's `UPDATE` waits for in-flight inserts, so after it commits no row names the old key; retirement counts after that. Aliases are counted by their parent's `expires_at` and revocation. Startup refuses dropping a non-retired key. Tests pause a callback and an alias arrival before insertion across a full rotation. (3.8, 5) |
| 3 M | `SqlConnection.ts:467` waits for a frozen follower's transaction; rev 7 claimed a rollback | New SDK operation `SqlConnection.quiesce(control)`: stop admission, settle the running statement, roll back the current owner directly (no client-lock wait) and mark it lost, keep the connection for control statements. Tests separate a frozen follower from a frozen leader. (3.2 step 4, 3.5.2) |
| Note | Web Locks: an exclusive request does not revoke shared holders | Reworded: "revocation requested" (the request, never awaited by hide, unmount or broadcast) vs "exclusive barrier acquired" (the grant). An activation already holding the shared lock completes and then latches as a running context. Test added. (3.2 step 2, 3.6) |
| Simplest choice | Control-only leader vs restricted replacement writer | Both, because each covers the other's failure: the control-only leader is the normal path, and `authorize` (which already runs first in every leadership) is the replacement when that leader is gone. No new process, channel or lock beyond `smithers-admit`. |

### Round 6 (revision 6 to 7)

| # | Finding | Resolution |
|---|---|---|
| 1 H | An offline boot reopens the store while the observer lives | Admission barrier: the observer holds `smithers-admit` exclusively until the revocation is durable, and every activation commits under a shared hold. The leader is never killed before the revocation commits: revoking mode interrupts the engine, rolls back, serves nothing else and retries. Test: a fresh offline tab with the observer open. (3.2, 3.5, 3.6) |
| 2 H | `created_at` doesn't prove the signing key | `cookie_key` is recorded per session and alias, from the signing `keys` value. Staged rotation: verifier first, then issuer, then retire at a zero count. Startup refuses dropping a live key. (3.8) |
| 3 M | A confirmed wipe is forgotten when the mark write fails | `wipe_confirmed` in the owner record is set idempotently by the confirmed revoke and cleared only by deletion. It blocks issuance and every admission (`wipe_pending`). Boots retry the mark. (3.5) |
| 4 M | Revocation-time count isn't the deletion-time count | The count is taken in the confirmed revoke's transaction, after which `wipe_confirmed` blocks every new-build admission, so it is final. An older-build undercount is named. (3.11) |
| Note | A delayed sign-out can expire a newer cookie | Claim narrowed to session reads; residual named. (3.8, 8) |

### Round 5 (revision 5 to 6)

| # | Finding | Resolution |
|---|---|---|
| 1 H | The prestarted read can restore a revoked permit | Issuing happens only when the permit is NULL. It needs a new session request dispatched after `authorize` reads the generation. The prestarted answer may only extend a valid permit, conditional on that generation. Test: the exact revoke-between-prestart-and-authorize interleaving. (3.5) |
| 2 H | `@none` doesn't bind an anonymous viewer | A new `@anonymous` device-person value resolves to no actor whatever the cookie. `@none` is kept only for session discovery. Older servers already return nobody. Test: none to Q. (3.7) |
| 3 H | Zero old-key session rows isn't enough to retire the encryption key | Encryption is no longer rotated: `SESSION_SEAL_SECRET` is pinned. The encryption secret's ciphertext producers are listed (session tokens, PKCE verifier, `RecheckRole` journal). Any future encryption rotation needs its own design covering journals. (3.8) |
| 4 H | Per-answer cookie refresh overwrites a newer sign-in | Per-answer refresh is removed. Only sign-in and sign-out set the session cookie: 400-day `Max-Age`, with the server's sliding `expires_at` deciding. The signing key retires by a count of live pre-rotation sessions, never by re-signing. (3.8) |
| 5 M | Revoke ignores the generation sent with it | Provisional revoke is conditional on incarnation and `genSeen`; when stale it is acknowledged and changes nothing. Confirmed revoke follows a post-latch confirming read. Both are idempotent. Only issue and revoke bump the generation. (3.2, 3.5) |
| 6 M | Coordinator disposal does not stop persistence; draft count | Claim corrected: disposal stops broadcasts only. Persistence stops at the commit boundary: the leader serves no statement after the revocation commits. The count runs in that transaction, so it is final. (3.4, 3.11) |
| 7 M | Tickets single-use only per Durable Object | Tickets carry purpose and exact destination, checked before consumption, so exactly one object can consume each. (3.9) |
| Notes | The confirmation-to-mark race may last longer than milliseconds; test the raw RPC send boundaries (`src/flows/tabPort.ts:76`, `:156`) | The race is restated as "between the confirming read and the mark write" (data loss only). The send-boundary tests are added to section 7. |

### Round 4 (revision 4 to 5)

| # | Finding | Resolution |
|---|---|---|
| 1 H | The absent-permit migration exception reopens a revoked device; temporary storage denial; cached older boots | **The exception is removed.** No permit row means no offline opening. The permit moves to SQLite, so localStorage denial is irrelevant. Older cached boots are named as a limit. (3.3, 3.5) |
| 2 H | A concurrent refresh recreates a removed permit | One writer, the leader. Conditional statements carry a generation that every revocation bumps. A stale extension or issue never commits. (3.5) |
| 3 H | Unordered confirmation; the worker's `ended` contradicts "superseded" | Revocation is provisional and undone by the next verified activation; the mark is destruction. An inconclusive confirmation destroys nothing. The confirmation uses the unbound identity read. The residual between confirmation and the mark write is data loss only, and named. (3.2) |
| 4 H | First-paint hand-over releases before it acquires | `pageWipe.open({ held })` adopts the shell's hold with no release. A marked case revokes first. (3.10) |
| 5 H | Missed coordinator channel; SDK-installed channels; running handlers | A realm-singleton latch read by every `TabChannel` constructor, including the SDK's. The coordinator's `dispose()` runs on latch. Handler scopes are interrupted, and the latched `post` blocks replies. (3.4) |
| 6 H | The outbox exception is not simple | **Dropped**, per the proxy's standing rule. Full wipe, plus discarded counts. (1, 3.11) |
| 7 H | Retiring the old key revokes renewed sessions | Signing and encryption retire separately. Encrypted tokens re-seal on open and through a durable flow. The old encryption key retires only at zero remaining rows. Tests run through retirement. (3.8) |
| 8 M | Alias cookie refresh tied to winning the parent renewal | Every live answer refreshes the presenting host's cookie with `Max-Age = expires_at - now`. Lifetime is described as 29-30 days. (3.8) |
| 9 M | Memory-tab lifetime contract | Requests are held until the tab's own answer fixes viewer and deadline. The timer is in memory. Q-offline and Q-to-R tests. (3.7) |
| 10 M | The draft count is not authoritative | `D` is counted inside the leader's revocation transaction, `U` by the deleting boot under the exclusive lock. When the ack is missing, the wording says so. (3.11) |
| Notes | Atomic single-use tickets; separate lifetimes; old clients unbound until enforcement; step 3 depends on 2 and 2b | 3.9, 5 |

### Earlier rounds

**Closed by Astra (round 4 dispositions):**
- receipt deadlines;
- socket viewer binding (design);
- snapshots;
- the blocked-storage loop;
- alias proof and terminal input;
- lease freshness (design);
- the server rule;
- round-2 recovery events.

**Still partial in round 4, now addressed:**
- round 3 #2 by 3.2, 3.5 and 3.8;
- round 3 #4 by 3.4;
- round 3 #5 by 3.10;
- round 3 #6 by 3.5 and 3.6, with the named residual.

**Pending:** the dispatcher integration (round 3 #10, round 2 #8).
