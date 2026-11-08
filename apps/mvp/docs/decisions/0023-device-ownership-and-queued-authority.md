# 0023 · Device ownership and delivery-time run authority

2026-10-21 · Accepted engineering fix for the MVP context review (findings 1 and 3). Amended the same day: an owner change seals the device's data instead of wiping it, and an earlier build's confirmed login counts. As first landed, every device upgrading from production was judged to have a different owner and wiped, losing its queued writes and drafts on first load (`e2e/device-upgrade.spec.ts`), against [0021](0021-local-first-migrations.md)'s rules 3 and 4.

## Device ownership

1. **Checked before anything opens.** Each time a worker is about to lead, `BrowserRuntime.run({ authorize })` checks who owns the device's data before the engine is built, any run resumes or any tab reads the shared database. It is never cached as a migration step. The owner record is a versioned bootstrap row, `smithers_device_identity`, beside the collections and outside every synced or clearable row; only the device wipe deletes it.
2. **An owner change never deletes.** Data belonging to someone other than the person signed in stays sealed: tabs run on memory stores and no engine, and the rows and queued writes wait whole for their owner. Expiry seals them the same way until the owner signs in again; offline, the owner's data opens as theirs. Only signing out deletes the device, as it always has: the person at the browser decides.
3. **An earlier build's confirmed session is its owner.** A device without an owner record belongs to the person its last confirmed session names: by stable id when that build kept one, else by GitHub login without regard to case (7b96f878 and production's c6940ac5 kept logins only). The match writes the owner record, and from then on only the id decides. A different person, or nonempty data with no confirmed session, stays sealed. A login proves less than an id, since GitHub can give a released login to someone else; exploiting that would already need this browser profile, whose files can be read anyway.
4. **Visitors' data is adopted, in place.** Data made signed out or offline on an empty device is a visitor's (`@visitor`); the next person to sign in owns it, as [0008](0008-auth.md)'s guest merge does. A tab already open on the visitor's data doesn't reload for it (2026-10-21, local-first track C): when a session answer names a person, its fetch asks the leader to adopt the data, the leader runs the owner check again with its activation's database and broadcasts the new owner, and every tab on the visitor's data takes it in place. The adoption's receipt is not continuous (rule 6), so the person who adopts the device never owns the outbox's unstamped writes, and writes stamped as the visitor or anyone else stay sealed. Only a refusal, or a leader that never answers before the request’s Effect deadline (15 s for session checks), reopens the page.
5. **Each tab and request is bound.** A tab opens the device store and the outbox only on its leader's receipt naming an owner; a leader answers a tab about to follow it against the browser's session now, and another person signed in since reopens every tab. Every own-origin API request names whose data it comes from: the owner, `@visitor`, or `@none` from a tab on memory. ChatApi reads a cookie or credential for another person as nobody and refuses a cookie-authenticated write or sign-out that names no one, as a pre-deploy tab sends, so an old tab's queued write can't act as the next person. Every session answer the page reads, at startup, on reconnect or after a `401`, checks its activation again: one naming someone else reopens the page and leaves the write queued, and a tab sealed only because no one was signed in reopens once someone is. Identity reads stay unbound; external requests carry no device header.
6. **A queued write is sent only as who queued it** (2026-10-21). The outbox lives in IndexedDB and the owner record in OPFS. A browser can evict one without the other, and an adopted visitor's device takes the person in place. So each write is stamped with the owner the tab opened the data as, and the outbox loads and sends only that owner's writes (`Outbox.Principal`). Another owner's stay sealed in the outbox until a tab opens the data as theirs.
   - **Unstamped writes:** a write an earlier build stored names no one. It is the owner's only when the owner held the device before this activation: recorded as its owner, or an earlier build's matching confirmed session (the receipt's `continuous`). This eligibility is persisted as `owns_unstamped` in the owner record. A fresh claim or visitor adoption sets it false, including on every later activation; reload cannot grant authority over sealed legacy writes. Existing owner records migrate with eligibility intact.
   - **Before:** after an eviction, the next person to sign in adopted the empty device and sent the earlier owner's queued questions as their own.

The rules, the table of outcomes and the records: [sign-in.md](../features/sign-in.md#the-devices-owner).

## Delivery-time run authority

A queued agent issue write retains its original signed proof and renews it at delivery through the existing credential route. The server checks its signature, live original session, identical current person/session and identical run, then copies every claim except expiry. It never reconstructs a wider lineage or interprets the write as the person's press. The write itself sends the renewed bearer with cookies omitted. Revoked, forged or cross-account proofs are refused; transient failures use the existing outbox retry policy. Payload version 3 migrates version 2 without changing its operation, write id or proof. The existing idempotency boundary handles replay.

Libraries used: `@smthrs/platform-browser` for host activation and the shared SQLite service; `@smthrs/effect-tanstack-db` for collections, outbox delivery and versioned schema/payload migration; the existing Effect run-credential services and durable engine. No second worker loop or retry mechanism is added. Observability records activation outcome, credential renewal/refusal and device-principal refusal without identities, credentials or message content.

Tests cover both deployed builds' upgrade with every row kept, a confirmed id or login matching and not, retained owner across expiry and the wipe, offline recovery, visitors, cross-account requests, exact attenuation, original-session revocation and replay. The browser regressions cover the deploy itself, expiry, draft recovery, account change across tabs, pending person writes kept for their owner and an evicted device reopening under its owner. Execution receipts are recorded in the work note; tests listed here do not imply a passing unexecuted suite.


## Pending sign-out and held delivery (2026-11-02)

Round-3 recovery keeps legacy ordering migration and admission serialization in
`@smthrs/effect-tanstack-db`, using its library catalog entry. Migration journals
only keys and sequences, never another owner's payload. On an ambiguous legacy
timestamp, held writes precede peers before deterministic key ordering. A
non-stealable admission lock drains a predecessor's persistence before the next
leader recovers its sequence. A failed wipe mark seals and stops its page while
releasing the sign-out guard, with an explicit wipe retry still available.

The current client stack protects an explicit sign-out with a browser-owned exclusive lock before the server call, retained through its wipe. Reopen senders acquire compatible shared guards with `ifAvailable`; receivers wait for the exclusive guard to release before honoring retained broadcasts. A crashed page cannot leave a permanent marker.

Held writes stay in the existing outbox row. Optional metadata records the hold and dependency keys; it does not change a feature payload schema. Dependency keys are text id, repository and issue number (or create id/settings), repository stack, run id, and chat conversation. Stack operations share one key because numbering depends on stack order. Missing keys are a conservative global dependency. The SDK retains the original executor, backoff and ownership checks, with an opt-in scheduler extension for independent held-write bypass. A shared invalidation causes every tab to reread owned persisted rows for its sign-in prompt. No extra storage, job or application retry loop is introduced.


## Round-4 recovery (2026-11-03)

Admission allocates from the stored rows' maximum under the admission lock through
row persistence. A queued callback after leadership reacquisition cannot reuse a
leader-local counter. Missing or duplicate sequences use the existing durable
migration plan, with held members before ambiguous peers. This round was superseded by the stored-counter recovery below. Unpublished local held membership survives invalidation, and repair validates
the affected rows before publishing the index.

Once the server ends a session, local session or confirmation failures still reach
wipe marking or safe sealing. The whole sign-out action releases the browser guard
in its finalizer. A wipe helper alone cannot own that cleanup because failures can
precede it. These changes retain owner filtering, send-time ownership checks, and
the server's device-person binding. No write gains another person's authority.

### Stale-credential continuation (2026-11-03)

Every same-origin `/api/` request from the bound transport, including internal
session rereads, advertises `x-smithers-accepts: credential-stale` so the server
can reserve its stale response for a client that handles it. Other origins and
paths receive no added capability header. This advertises support, not authority.

The bound transport consumes the server's `503` plus
`x-smithers-credential: stale` before a feature can classify its status.
It retains a reversible transport gate and raises `credential_stale`; durable
outbox retries drive continuation. A retry sends no write until `Retry-After`
has elapsed and a session reread names its bound person. The reread carries the
optional tag stored with the verified owner in the bootstrap record's additive
`session_tag` column. The tag is diagnostic, never authority; owner filtering,
send-time checks and server device-person binding still decide who may send.
AuthClient preserves `credential_stale` as a distinct failure code, so the data
gate hides private rows until a session is confirmed again. A later network
failure cannot clear that hiding. A failed credential-state write keeps its
deadline in the transport immediately. Reporting the observed refusal never
waits for storage or its lock, so a stalled publication cannot become a generic
session timeout that leaves private rows visible. Subsequent writes remain blocked until
the pending state is published, its delay expires and the owner is verified.
Inconclusive rereads retain queued data. Existing sign-out and different-person
paths remain in force. The dependency patch remains unchanged; the SDK admission counter is described below.

### Round-5 client recovery (2026-11-03)

Use the library catalog's `@smthrs/effect-tanstack-db` outbox. Recovery reconstructs
`outbox:admission-counter` under the existing shared admission lock. Each admission
reads this one row and commits its increment with the write through the host's
atomic `storage.setMany`. The browser boundary uses one IndexedDB transaction;
a failed batch admits neither row. Counter metadata survives an empty queue and
is never offered to the executor. Followers never allocate or repair sequences.

Held-status refresh revalidates both indexed keys and cached membership against
the actual stored rows, including followers that discovered an unpublished hold
at startup. Missing index membership stays dirty for repair on leadership or
existing retry steps. Ownership still comes from each row, never the index.

Chat questions opt into the same session confirmation and durable hold as other
queued session writes. A held question remains queued and offers sign-in across
reloads rather than being removed to Not sent.

Only accepted reopens update the tab's throttle mark. Suppressed requests retain
a timer at the existing eligibility boundary; repeated failures cannot move that
deadline. Sign-out guards still protect the request through its wipe, and a
suppressed request remains eligible once the guard releases.

The bound transport persists an owner-keyed stale-credential deadline and revision
in the same device outbox store, deleted by sign-out's wipe. Pages and workers
serialize publication and write-gate reads with one Web Lock, so a successor
cannot read an old record while another context is publishing. Every sending context reads it before
writing and verifies the owner after the deadline before its first send for that
revision. A newer revision invalidates a context's earlier verification. The
record remains for successor verification until wipe; it contains no credential
or user payload. A context verifies again after reload or leadership transfer.

A rejected publication retains that lock while the observing context lives;
successor transports cannot bypass the unpublished deadline by reading an old
record. Each ordinary request in the observing transport can attempt publication
again within its held lock. Reads and explicit sign-out do not await it, so auth
refresh can recover storage even when another context owns the waiting write.
No timer or resend loop is added. Publication releases the fence only after all
observed deadlines are stored; durable outbox attempts still own write retries.
An ordinary request recovers every publication this transport holds, including
one from before visitor adoption changed its principal. Each stays under its
original owner key. A write fails as held if any of those attempts fails or
leaves a newer observation unpublished; it never waits for its own failed fence.
Memory-only pages use memory state and retain their first verified transient person;
a later reread must match that person, and the resulting transient send carries their binding. This never opens,
adopts or releases a retained owner's data. A different person cannot verify a
retained owner's gate. Session tags remain diagnostic only.
