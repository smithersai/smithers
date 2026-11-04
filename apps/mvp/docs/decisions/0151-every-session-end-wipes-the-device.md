# 0151 · Every session end wipes the device

2026-11-02 · Accepted; steps 0, 1 and 5 built. Step 1b is implemented on its review stack and awaits Astra; steps 2, 2b, 3 and 4 remain. Supersedes [0023](0023-device-ownership-and-queued-authority.md) rule 2. Expiry, revocation and a person change left open pages rendering the previous person's content, and an offline reload could reopen it. The design, at revision 17, with its reviewed executable model and each finding's resolution, is [design/device-privacy/design.md](../design/device-privacy/design.md).

> effectscript-11 decision, 2026-11-02: any session end (expiry, revocation, account change) wipes all device private data, like sign-out; seal-and-keep rejected; drafts/outbox wiped with the discarded count shown. Why: privacy over convenience, but no surprise work loss.

2026-11-03 refinement (effectscript-11): a server-side failure to verify a live row's cookie is inconclusive, not an end.

## Rule

1. **Every session end clears the device, as sign-out does.** Expiry, revocation, sign-out on another device and another person signing in all wipe it. Unsent writes, drafts and in-progress client runs are discarded, and their counts are shown once.
2. **Sessions slide and are capped.** A session lasts 29–30 days after its last session read, and at most 400 days from its start, enforced by the server; the cookie's own expiry decides nothing. From day 393 a non-blocking banner says "Sign in again to keep your session". Signing in again as the same person with a live cookie for that session renews the same session row in place for a fresh 400 days, with no wipe. Any other sign-in creates a new row. A verified account change wipes; the same person under a new tag adopts it when the recorded row is live or absent, and wipes when it is ended. A failed lookup keeps the old tag and refuses.
3. **One revocation latch per realm.** A tab or worker that observes its owner's session end revokes every outward path of its realm in that task: requests, sockets, both tab RPC systems, the collection coordinator's channel, worker factories, host calls and the DOM. A deadline timer is a local prediction: it first holds those paths reversibly for one session read, and only a confirmed end latches.
4. **An offline permit in the owner record.** The device opens offline only with an unrevoked, unexpired permit, issued by a verified activation from a session read dispatched after the latest revocation. Only the leading worker writes it, through generation-checked statements.
5. **Destruction only after confirmation.** A device destroys data only when a verified answer names another person or its recorded row shows the end. A signed-out answer, a lost cookie, a failed signature, a stale credential and a failed lookup are inconclusive. The confirming read carries the recorded random tag; `prior` is `ended`, `live`, `absent` or `failed`. Absence is never an end, and failure keeps the recorded tag. Revoking the permit hides private content without deleting unsent writes. A confirmed end blocks every activation until deletion completes.
6. **Revocation outlives a stuck leader.** While an observed end awaits durable revocation, the observer's exclusive admission lock blocks every activation in the origin. The revoking leader stays a control-only writer until the outcome is final; every later leader commits pending revocations before it asks for admission; a stuck leader's worker is terminated by its tab and replaced by a latch-exempt recovery worker that can only commit revocations.
7. **A re-keyed credential is not an end.** A cookie signed by a configured key for a live session now stamped with another key answers `credential: "stale"`: it authenticates nothing, and the page holds without confirming an end until a current cookie arrives or the person signs in again. Only guarded requests sending exactly `x-smithers-accepts: credential-stale` answer `503`, `x-smithers-credential: stale`, `Retry-After: 1` and `Cache-Control: no-store`. Other requests keep the pre-503 empty `401` with `x-smithers-credential: stale` and `Cache-Control: no-store`, without Retry-After or a refusal code. The client stack enables the header only with reversible hold and write retention implemented.
8. **Memory tabs and anonymous tabs are bound.** A memory tab fixes its viewer and deadline from its own session answer before accepting authenticated responses. A tab with no viewer is bound as `@anonymous`, so it never receives a signed-in person's data.
9. **One clock for deadlines.** The server samples `serverNow` with the database's `clock_timestamp()` in the same lookup that reads the session's end, after any renewal; clients derive deadlines as `sentAt + (expiresAt - serverNow)`, and socket leases as `queryStartedLocal + min(60 s, expiresAt - dbNow)`.

## Consequences

No recovery protocol exists. Offline use needs one online activation after updating. Session cookies are set only at sign-in and sign-out. At day 400 a person who has not signed in again is signed out even while active, and the device's unsent changes and drafts are wiped, with counts shown. The signing key rotates with fingerprint-checked overlap: the issuer is chosen inside the session's insert from durable key state, a cookie authenticates only while its key equals the session's, cessation is read from the database clock after promotion commits, and the deploy refuses to drop any key until the database's time passes cessation + 401 days. The first publication pins a NULL fingerprint for the sole legacy issuer and a NULL seal pin from this deployment's held secrets, even with existing rows. Both initializations log after commit without secret material. The `0108` to `0116` upgrade needs no cookie bootstrap or operator step; a wrong initial secret signs people out as before and does not block deployment. Later mismatches refuse. An operator may clear a lost seal pin with `reset-seal --confirm-sign-out`; the next gate pins its configured seal, whose change makes old ciphertext unreadable and signs affected people out when their tokens are next opened. Emergency omission requires cessation plus 30 seconds, transactional ends, a compromised label and no raw live row stamped with that key. GitHub tokens replaced by a renewal or orphaned by a lost refresh are revoked through a cleanup queue that never ends the session. Sockets need a single-use viewer ticket and hold a per-frame lease. Frozen or hung renderers, older cached builds, unobserved ends and buffered heap are named limits, not guarantees.

A bug that writes false ends into rows still wipes. [worker/SessionEndWriters.test.ts](../../worker/SessionEndWriters.test.ts) inventories every lifetime SQL writer and migration, but cannot catch an allowed writer firing wrongly.

Every terminal path transfers sealed GitHub tokens to cleanup and clears the row in the same transaction as revocation and the anonymous end receipts. The durable sweeper retains an ended session row for 30 days and its receipt for 400 days. Before erasure it preserves the person's newest role receipt, including a demotion. That role receipt lasts until the person is deleted; anonymous ends have no person foreign key. No non-test code deletes people. Receipts on account deletion are unproven: the existing test deletes a person only after session erasure, so it proves no account-deletion path. Account deletion stays open. Past 400 days an erased tag answers `absent`: the same person may adopt a new tag and retain data, while a verified different person still wipes.

The `cookie_rejected` alert is inert with no metrics exporter and counts as neither alerting nor a safety control.

## Reauthorizing a pending triage write

A fresh authenticated same-ID resubmission may replace a pending triage write's captured authority after reauthentication. Its owner, repository, operation, payload and attribution must match. Both session and role are checked inside the transaction, and the session is checked again after the final write. The write row serializes reauthorization with execution; an attempt that resolved a role for the earlier admission retries without settling the new one. Unavailable authority stays pending, confirmed denial remains terminal, and settled writes are never reopened. A key change alone never upgrades a recorded write. Home callbacks and alias handoffs must recover without restoring old database key stamps. Exhausting the normal send window does not terminalize an unavailable local triage write: the existing final step retries the guarded execution until authority recovers or a confirmed denial settles it. External GitHub writes retain their existing failure policy.

Permission denial is terminal only when its retained observation is still fresh
under the role lock and the captured session is still live after the write lock
is acquired. A replaced denial uses the current role; expired observations,
expired sessions and installation refusals without a fresh role observation stay
retryable. Both the role and session deadlines guard a denial's settlement after every potentially blocking mutation and receipt fold. Deployment authority uses the newest receipt's verification time and configured role window; missing, future-dated or expired observations are unavailable. Repository freshness is rechecked after session/alias locks. The same final guard protects secret writes and pending-write reauthorization.

## Retrying failed signing-key operations

The operator retains its stable first execution ID. A new invocation resumes
active or completed work; a terminal failure admits a stable next attempt through
the catalog's `@smthrs/flow` `retryFrom`, at the recorded failed step. History is
retained, earlier steps replay, and the engine owns all waits and retries. The
operator reads prior attempt receipts to select one execution per invocation;
it does not retry execution itself. A different emergency replacement is refused
before admitting a retry of the recorded intent.

## Rejected

Seal and keep, and a 24-hour outbox exception (four review rounds found freshness, recovery and retention races in every keep-something protocol); an absent-permit migration exception (it cannot tell unmigrated from revoked); a localStorage permit (its read-modify-write is unordered across tabs); a socket subprotocol; retiring keys by the browser's cookie expiry (clock changes, delayed and copied cookies defeat it); treating any same-person sign-in as a continuation (a sign-out elsewhere would then never wipe); a successor session with an inherited lineage and a grace window (revocation did not follow it, and aliases could not prove continuity).


## Step 1b blocking corrections (2026-11-05)

Each isolate attempts the durable maintenance start at most once, with a one-second
bound. Failure is logged and counted but never changes a request's answer. The
existing durable alarm owns subsequent maintenance; a failed seed can be tried
by a later isolate.

Coedit reads session liveness once after its insert (including any unique-index
wait), without row locks. We accept the small race: revocation or expiry between
that read and commit may allow that one text update. This avoids serializing
keystrokes with session maintenance. Other protected writes keep their locks.
Repeated sweeps update ended home and alias rows only when values actually change.

Library catalog entries used: `@smthrs/flow` for the existing durable operator
steps and maintenance alarm; `@smthrs/sync` for shared-text validation.
