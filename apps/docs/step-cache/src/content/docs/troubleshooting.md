---
title: "Troubleshooting"
description: "Every failure @smthrs/step-cache reports, the message it carries, what caused it, and what to change, plus the symptoms that are correct behavior rather than errors."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/troubleshooting.md"
---

Every operation of every tier fails with one `CacheStoreError`, carrying a
stable `code` and a message that names the offending field. Find your message
below. The error schema and the code vocabulary are on the
[API reference](/reference/api/).

Boundary diagnostics never echo the rejected payload, so a message tells you
which rule was violated and not what the value was.

## invalid_cache: keyDigest violates the cache-key contract

**What happened.** A key was empty, longer than 256 characters, or contained
something outside `[A-Za-z0-9_-]`: a dot, a path separator, a control
character, or ill-formed Unicode. The check runs before any statement or
request is issued, so nothing was read or written.

**What to change.** Pass the digest your key derivation produced, unmodified.
The grammar is narrow because the same token becomes a bound SQL parameter and
a URL path segment under a shared tier's `/ac/` namespace. If you are
constructing keys yourself, hex or base64url output fits; a file path or a
human label does not. See
[what the cache admits](/concepts/admission/).

## invalid_cache: a provenance selector or fence

**Messages.** `recordedBy violates the provenance contract`, or
`eviction fence violates the provenance contract`.

**What happened.** A `(runId, eventSeq)` pair was malformed: an empty run id,
one longer than 1,024 code units, one containing a NUL or a lone surrogate, or
an `eventSeq` that is negative or not a safe integer.

**What to change.** Read the pair off the entry you are fencing on rather than
reconstructing it. A fence naming an impossible event is a compare-and-swap no
row could satisfy, so the store reports the caller mistake instead of answering
an ordinary "nothing matched". `CacheStore.validateRecordedBy` and
`validateFence` are the same checks, exported.

## invalid_cache: an age bound

**Messages.** `maxAgeMs must be a non-negative safe integer`, or
`olderThanMs must be a non-negative safe integer`.

**What happened.** A lookup bound or a sweep bound was negative, fractional, or
past `Number.MAX_SAFE_INTEGER`.

**What to change.** Pass whole milliseconds. Zero is legal and means "only a
row recorded at or after this instant". A duration in seconds is the usual
cause.

## invalid_cache: result or meta the store cannot admit

**Message.** `result <complaint>` or `meta <complaint>`, where the complaint
names the rule.

**What happened.** The value is not bounded, inert JSON. Admission copies the
tree without invoking a getter or a `toJSON` hook, so it refuses anything it
cannot copy faithfully:

| Complaint                                                | Cause                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `contains a non-JSON undefined`, `function`, or `symbol` | A value JSON cannot represent                                       |
| `contains a non-finite number`                           | `NaN` or an infinity                                                |
| `contains a cycle`                                       | The tree references itself                                          |
| `exceeds the JSON byte limit`                            | Past 4 MiB encoded, counted the way the canonical encoder emits     |
| `exceeds the maximum JSON depth of 128`                  | Too deeply nested                                                   |
| `contains more than 100000 JSON values`                  | Too many nodes                                                      |
| `exceeds the JSON members limit`                         | One array or object with more than 100000 members                   |
| `contains unbounded or ill-formed text`                  | A lone surrogate, or a string past the byte budget                  |
| `contains an unbounded or ill-formed object key`         | The same, in a key, whose own budget is 16 KiB                      |
| `contains a sparse or accessor array member`             | A hole in an array, or an array index backed by a getter            |
| `has an enumerable non-index array member`               | An array carrying an extra enumerable property                      |
| `has an invalid array length`                            | A `length` that is not a safe integer value                         |
| `contains a non-plain object`                            | A class instance, a `Map`, a `Set`, a `Date`, a `Buffer`            |
| `contains an accessor`                                   | A getter or setter on an object                                     |
| `contains an enumerable symbol`                          | A symbol-keyed enumerable property                                  |
| `cannot be inspected without executing object code`      | A proxy or exotic object that throws while its descriptors are read |

**What to change.** Serialize the value into plain JSON before recording it.
A `Date` becomes a number or an ISO string, a `Map` becomes an object or an
array of pairs, a class instance becomes a plain object. Cached results are
returned to a flow as the step's own result, so the store stores them verbatim
and cannot lossily coerce them for you.

A rarer sibling, `result must have a bounded canonical JSON form`, means the
value passed admission and the canonical encoder still refused it. Treat it the
same way.

## invalid_cache: the entry shell

**Messages.** `cache entry cannot be inspected as inert data`, or
`cache entry violates the persistence contract`.

**What happened.** The first message means the object you passed to `put` is
not readable as plain data: a missing or non-enumerable field, an accessor
where a value belongs, an extra enumerable own property, a symbol key, or a
non-object. The second means the six fields were readable and one failed its
schema: a bad `keyDigest`, an empty or oversized `recordedRunId`, or a
`createdAtMs` or `recordedEventSeq` that is not a non-negative safe integer.

**What to change.** Build the entry as a plain object literal with exactly the
six fields. The shell may be any object carrying those six as enumerable own
data properties, so a class instance is accepted and its prototype methods,
including a `toJSON` hook, are never called; an extra enumerable own property
is not. The nested `result` and `meta` trees still have to be plain. The store
reads each field through its property descriptor precisely so a hostile or
merely mutable argument cannot change value between validation and the write.

## invalid_cache: the shared tier's configuration

**Message.** `remote cache <field> is invalid`, raised while building
`RemoteCacheStore`, before any request.

| Field                | Rule                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `options`            | An unknown key, an accessor, or a symbol key on the options object, or a header value that is not plain bounded text |
| `endpoint`           | Not a string, not parseable as a URL, longer than 16 KiB, or carrying surrounding whitespace or control characters   |
| `endpoint protocol`  | Not `https:`, and not `http:` on a loopback host                                                                     |
| `endpoint authority` | Carries userinfo, a query, or a fragment                                                                             |
| `requestTimeout`     | Not a positive, finite duration                                                                                      |
| `maxResponseBytes`   | Not a positive safe integer, or larger than the 4 MiB protocol bound                                                 |

**What to change.** Give the endpoint as an origin with an optional path
prefix, put the credential in `headers` rather than in the URL, and keep
`maxResponseBytes` at or below `RemoteCacheStore.maximumEntryBytes`. The
message names only the violated rule, so a rejected
`https://user:secret@host` never reaches a log line with its credential.

## constraint or persistence_failed: cache persistence failed

**What happened.** The database refused a statement. The code is `constraint`
for a constraint or unique violation and `persistence_failed` for everything
else. The driver's own error is on the `cause` field.

**What to change.** Read the cause. The two common ones:

- `no such table: flows_step_cache`. The migrations did not run.
  Compose `Migrations.layer` beneath `CacheStore.layer`, as in
  [compose a durable step cache](/guides/compose-a-store/). In a durable
  engine, `Migrations.sets` in
  [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) installs every set in dependency
  order.
- A locked or unwritable database file. That is a composition or a filesystem
  problem, not a cache one. See [`@smthrs/database`](https://database.smithers.sh/reference/api/).

## decode_failed: a stored row

**Messages.** `could not decode flows_step_cache row`,
`could not decode result_json`, `result_json exceeds the 4194304-byte limit`,
or `result_json <complaint>` using the admission vocabulary above. `meta_json`
appears in the same messages.

**What happened.** A row in the database did not decode back into a
`CacheEntry`. Something other than this store wrote it, or the file is damaged.

**What to change.** Back up the shared database before recovery. Evict or
repair only the affected reusable head rows in `flows_step_cache`. Evicting a
digest lets the next execution record a fresh head. Only reusable head rows
are disposable.

Do not delete the database file. Preserve or restore the immutable
`flows_step_cache_recorded` provenance ledger and any colocated durable state
from a backup. The file may hold other services, including the journal and run
store in the [engine composition](/guides/compose-a-store/#prefer-the-engines-composition).
Recomputation cannot reconstruct the exact result a past event recorded. If
the ledger or other durable state is damaged, restore it from a backup rather
than replacing it with recomputed results. See
[ledger retention](#flows_step_cache_recorded-grows-and-nothing-reclaims-it)
for coordinated ledger cleanup.

## persistence_failed: the shared tier

| Message                                                                     | Cause                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `the remote cache tier refused a lookup`                                    | The transport failed: DNS, TLS, a connection reset                      |
| `the remote cache tier refused a lookup body`                               | The response body stream failed, or its bytes were not valid UTF-8      |
| `the remote cache tier answered a publication with HTTP 500`                | A non-2xx status that is not the `404` or `409` the protocol defines    |
| `the remote cache tier returned 8388608 bytes, past the 4194304-byte bound` | A declared or streamed body past `maxResponseBytes`                     |
| `the remote cache tier did not finish within its configured deadline`       | The whole operation, request and body together, passed `requestTimeout` |

**What to change.** Check the tier, its credential, and the network first. A
status failure usually means the service is not the one this client speaks to:
`404` is the only status that means a miss, and `409` the only one that means a
conflict. If bodies are legitimately large, raise `maxResponseBytes` up to the
4 MiB bound, and reduce what the step records into `result` past that. See
[implement a shared cache server](/guides/implement-a-shared-tier/).

`CombinedCacheStore` degrades a refused shared lookup to a miss and preserves a
successful local outcome when an inline publication is refused. Both refusals
increment `flows_step_cache_remote_failures`; inspect the `operation` attribute
to distinguish reads from writes. Use `"deferred"` mode to keep the network
round trip outside a database write transaction.

## decode_failed: the shared tier's answer

**Messages.** `the remote cache tier returned an entry that is not a bounded CacheEntry`,
or `the remote cache tier answered <requested> with an entry for <returned>`.

**What happened.** The tier answered `200` with a body that is not an entry
this store can admit, or with an entry recorded under a different key. The
second is refused outright: handing back a result under the wrong key is the
one thing content addressing must never allow.

**What to change.** Fix the service. A cross-key answer is a routing or a
storage-key defect on the tier, and a body refused as unbounded usually means
the tier stores entries in a shape this client does not define, or does not
apply the same admission rules the client does.

## unknown: a row disappeared during put

**Messages.** `cache provenance disappeared during put`, or
`cache entry disappeared during put`.

**What happened.** A row that had just blocked an insert was gone when the same
transaction read it back. Inside a serialized write transaction that cannot
happen.

**What to change.** Check the write boundary. This is the signature of a
`DurableWriter` composition that is not actually serializing writes, or of a
second process writing the same file outside it.

## unknown: get is unavailable

**What happened.** A test composed `CacheStore.layerNoop` or
`CacheStore.makeNoop` and the code under test reached a method the test did not
override. The message names the method.

**What to change.** Supply that method in the overrides, or provide
`TestCacheStore.layer` and use the real store. The noop store fails loudly on
purpose: a silent miss would make the test pass for the wrong reason. See
[test against the step cache](/guides/test-with-the-cache/).

## A recording answers Conflict and you expected ExistingSame

`Conflict` means the store is refusing to overwrite bytes it already holds. It
arrives from either of two stages, and only the second one involves two runs.

- **The provenance stage.** You re-recorded the same
  `(keyDigest, recordedRunId, recordedEventSeq)` triple with a different
  `result`, `meta`, or `createdAtMs`. That record is immutable. A retry must
  present the same bytes, including the timestamp, which means capturing
  `createdAtMs` once and reusing it rather than calling the clock again.
- **The head stage.** Another run already recorded a different canonical
  `result` under this digest.

Read `flows_step_cache_recorded` at the exact
`(keyDigest, recordedRunId, recordedEventSeq)` you recorded to tell the two
apart. A row already there is the provenance stage, and comparing its
`result_json`, `meta_json`, and `created_at_ms` against what you passed names
the field that moved. No row there is the head stage, and the
`recorded_run_id` and `recorded_event_seq` on the `flows_step_cache` row for
that digest name the run that got there first.

If neither describes what you did, the digest is under-specified: two genuinely
different computations are deriving the same key. Fix the key derivation, not
the cache. Two structurally equal results built in different key orders are
never a conflict, because the store canonicalizes before it compares.

## A step runs again even though its result was recorded

Work through these in order.

1. **The digest changed.** Content addressing is upstream of this store: a
   changed input, tool version, or step definition is a new key and therefore a
   genuine miss. See
   [content addressing](https://smithers.sh/docs/concepts/content-addressing/).
2. **An age bound refused it.** A lookup carrying `maxAgeMs` answers a miss for
   a row older than the bound, and leaves the row on disk. See
   [expire cached results](/guides/expire-cached-results/).
3. **The head was evicted or swept.** Both remove the reusable copy. The ledger
   row survives, which is why a fenced replay still reads its own bytes while
   an ordinary lookup misses.
4. **The provenance fence found nothing and the head is gone.** A lookup naming
   a `recordedBy` the ledger does not hold falls back to the head, and a lookup
   naming one it does hold is bounded by `maxAgeMs` without falling through.

## A fenced read or eviction behaves as if unfenced

Against a shared tier only, and with no error. A server that ignores the
`recordedRunId` and `recordedEventSeq` query parameters turns a fenced lookup
into a head read and a fenced eviction into an unconditional `DELETE`. The
client cannot detect it, because a conforming tier answers a fenced lookup with
its head whenever it holds no row for that provenance.

**What to change.** Make the tier conforming, or compose it for its head
semantics alone and keep fenced operations on the local store. The contract is
in [implement a shared cache server](/guides/implement-a-shared-tier/).

## sweepExpired answers 0 in a two-tier composition

Correct behavior. `CombinedCacheStore.sweepExpired` sweeps the local tier only,
and `RemoteCacheStore.sweepExpired` validates its argument, issues no request,
and answers `0`. One host's retention says nothing about what a sibling machine
still needs, so the shared tier owns its own collection policy. The same is
true of `evict`.

## The hit rate reads low on a machine with a shared tier

Also correct behavior. `RemoteCacheStore` updates no counters, so a lookup
served from the shared tier registers one local `miss` plus the write-back's
`Inserted`. The rate measures how often this machine already held the entry,
not how often a result was reused. See
[observe cache outcomes](/guides/observe-cache-outcomes/).

## flows_step_cache_recorded grows and nothing reclaims it

By default, `sweepExpired` preserves the ledger. Whole-run reclamation belongs
to [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/), whose retention pass erases a
terminal run's ledger rows by `recorded_run_id` together with its journal.
That pass cannot match a write-back recorded by a run on another host.

Configure `sweepExpired(olderThanMs, { canReclaimRecorded })` on the local or
combined store to collect old, unreferenced imports. The callback receives
`{ keyDigest, recordedRunId, recordedEventSeq }` and returns an Effect of
`true` only when no retained local journal, fork, or run needs that exact
provenance. Keep locally owned run evidence until its journal is retired.
Unknown reference state must return `false` or fail. Absence of the recording
run on this host alone is not proof: local frames can reference remote runs.

Pause execution and replay on every process sharing the database from before
reading references until the sweep commits. A writer transaction protects the
check and deletion, but cannot protect a reader that has obtained a cache row
and has not yet journalled its reference. Run the policy as a local read, with
no network calls or writes, inside that transaction.

The same age floor applies to heads and ledger candidates. Ledger candidates
are visited in pages of 100 identities; retained candidates do not prevent
later candidates from being checked. A callback failure rolls back the entire
sweep. The return value remains the number of heads deleted. The combined
store forwards the policy only to its local tier.

Schedule this sweep with the host's retention pass. Releasing the last local
reference lets the next sweep collect an old import, including imports made
before this policy existed. Without the callback, ledger retention remains
conservative and foreign rows continue to accumulate. See
[the head and the ledger](/concepts/head-and-ledger/).
