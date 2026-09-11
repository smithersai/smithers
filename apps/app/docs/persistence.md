# UI persistence

The UI has one logical state machine and two persistence implementations. The
backend changes durability, not collection shape or reducer behavior.

## Backend selection

`createAppStore()` chooses a backend before creating any TanStack collection:

- **OPFS SQLite** is preferred. `SqliteRowStorage.ts` stores one physical row
  per entity and uses a real SQLite transaction for each logical dispatch.
- **localStorage** is the compatibility fallback. `TransactionalStorage.ts`
  stores a versioned envelope and uses a staged write-ahead key so a dispatch
  has one recoverable commit point.
- **memory** is a read/write-isolated degraded session. It is used when the
  recorded OPFS store cannot be opened, so a transient failure cannot fork or
  overwrite the durable conversation.

The selected durable backend is recorded separately in localStorage. Once a
browser has data in OPFS, failure to open OPFS never silently falls back to a
possibly stale localStorage database.
An unknown backend stamp stops startup without probing or selecting another
store. An absent stamp permits first-launch selection; an invalid one does not.

An absent stamp is not necessarily a first launch: older per-key/envelope
localStorage data is checked first. When it is the only existing store, boot
validates and adopts it, then records localStorage after successful
initialization. It does not open a fresh OPFS database over that history. If
an OPFS database also exists (or its existence cannot be established), boot
refuses to choose between potentially different histories. Appearance mirrors
and bookkeeping stamps alone do not count as another live store.

Theme and palette mirrors are best-effort. A refused localStorage accessor or
write does not stop appearance changes or memory-backend initialization. The
session remains the authority for both values.

Fallback applies only when the browser cannot acquire the database. Once
SQLite opens, a schema, validation, read, migration or commit failure stops
startup and closes that handle. It does not stamp a different backend, start
an empty memory session, or reinterpret a refused execution journal as new
work. A failed cleanup preserves the original refusal as the startup error.

Unreadable SQLite addressing metadata (including binary row keys, versions,
collection names or legacy registry entries) also refuses opening. Skipping
those records could hide authoritative evidence or permanently stamp an
incomplete legacy import. Ordinary row quarantine requires readable addressing
metadata and an explicit validation failure; a validator/key-check exception
stops opening without changing or quarantining that source.

The acquired SQLite handle also belongs to AppStore during initialization:
seed or later boot failures attempt closure before rejecting, retaining the
original boot error. A successful store transfers that responsibility to its
caller. Await `store.dispose?.()` or `controller.dispose()` when releasing it.
Controller disposal stops workflow pumps and releases resources in reverse
acquisition order, awaiting asynchronous dependents before their hosts. It
attempts every finalizer and reports failures together; repeated calls share
the same completion or rejection. A resource registered after disposal must
be released by its acquiring caller awaiting `onDispose`'s returned completion.

Each active explanation belongs to that scope. Disposal clears its timeout,
removes its agent listener, and cancels its side turn. Disposal and late stream
or start-request callbacks do not publish explanation card patches. Completed
explanations need no further cancellation.

Native sign-in disposal clears the polling wait, aborts start, claim and session
requests, and prevents late responses or browser opens from changing the store.
A repeated sign-in click while its start request is pending reports preparation;
it reopens the browser only after the handoff URL exists.

## Controller request bounds

`controller/context.ts` bounds non-streaming requests, including target listing,
with one 30-second deadline (`seamTimeoutMs`) covering headers and body EOF.
It buffers at most 8 MiB of response bytes before returning a Response for
JSON or text decoding. Timeout rejects with `seam timeout`, aborts the fetch,
and cancels the reader without awaiting transport cleanup. Oversized bodies
reject with `seam response exceeds 8 MiB` and cancel the reader. Failed target
queries settle the pending card with the error. Turn and model relay streams
use their own streaming paths.

## Collection contract

`PERSISTED_COLLECTION_SPECS` in `state/AppStore.ts` is the authority for every
persisted collection and its Standard Schema validator. Both backends expose
a `StorageApi` view for loading validated rows. `DurableCollection.ts` seeds
TanStack local-only collections from that view and persists transaction
mutations before confirming them through the collection's sync interface.
SQLite commits use `applyRows(collectionId, deltas)` directly; only changed
rows are encoded and written. The coordinator retains committed rows for
stale-state checks and rewinds tentative changes after a refused commit.
Retained collection history is neither parsed nor serialized on an append.
localStorage and older injected hosts without `applyRows` retain the full
collection envelope path.
The store remains the only write authority: UI components project collections
and mutations enter through the controller/dispatcher.

Each durable commit is serialized with the others. A failed commit rolls back
optimistic collection state; queued transitions derived from that failed state
also reject. Each mutation checks its original row against durable data, so a
dispatch started during another transaction's rollback cannot persist stale
optimistic fields. A fresh dispatch after rollback may retry. Direct collection
inserts used during seeding follow the same durable-before-confirm order.

`store.dispatch(transition)` applies the change optimistically and returns its
TanStack transaction. `transaction.isPersisted.promise` is the durability
receipt: it resolves after the commit, and after `flush()` on SQLite, and it
rejects when the commit fails and the change rolls back. A transition the
reducer refuses resolves at once with no change.

```ts
await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
```

The durable navigation collections are `app-workspaces`, `app-branches`, and
`app-frames`. Frames refer to existing card records; maximizing a card changes
navigation state rather than copying or remounting the card.

A maximized frame records the conversation, cards, world documents, and draft
at its revision. Later card updates change the card row only; the recorded
snapshot keeps its revision. Forking restores that snapshot into a new branch.
Switching branches saves the outgoing branch's current projection and restores
the incoming one atomically, so edits and conversation resets stay in their
branch. Branch switches and forks wait until an active turn finishes.
Account-state removal also clears archived snapshots.

## Composer drafts

`composer.changed` keystrokes share one durable commit. The draft is visible
at once; the commit lands 250 ms after the last keystroke, at most 1 s after
the first unsaved one, or earlier on the next other dispatch, `pagehide` or
`store.dispose()`. Every keystroke in that window returns the same receipt,
and the journal holds one `composer.changed` record with the final draft.
A localStorage commit rewrites the whole envelope, so one commit per keystroke
copied every saved collection per character. A crash inside the window loses
at most those keystrokes.

## Clearing and recovering a conversation

`/chat.clear` archives the current conversation locally and starts a new one.
It requires neither sign-in nor a model request. The confirmation contains a
durable frame URL for opening the old conversation, including after reload;
browser Back/Forward also traverse these branches. The snapshot preserves
messages, cards, the unsent draft, and the World documents at that revision.
World is branch-owned: opening an archive restores its historical notes, not
the current branch's notes. This does not cancel independent workflow runs.

`/chat.clear --summarize` additionally requests model-generated World notes.
They are new documents with `chat-sweep` and source-conversation provenance;
no generated title selects or overwrites an existing document. Case-folded,
Unicode-normalized path collisions receive numeric suffixes. Existing notes
retain their content, attribution and revision. The archive, optional notes,
new branch/root frame, cleared projection and journal record commit together.
A failed write rolls back all of them; success is reported only after commit.
An active chat turn is stopped separately and cannot be revived by rollback.
Agent-requested clearing asks the human for confirmation through the same Flow.

Summarization accepts at most 768 KiB of UTF-8 request JSON and 256 KiB of
response bytes, with a 30-second deadline covering headers and body. It never
silently truncates the transcript. A valid response must end with an explicit
successful `done`/`stop` frame and EOF; partial, malformed, failed or cancelled
responses save nothing. A summary contains at most 50 schema-validated notes.
Concurrent conversation/identity changes invalidate it; unrelated toasts and
user note edits do not. A local clear cancels a pending summary. Oversized or
unavailable summaries leave the local archive/start-new path available.

Archives are retained as branch snapshots, not as the bounded transition log.
In a degraded memory session they last only until the session closes, and the
confirmation explicitly says so. They are local history, not a backup or a
secure deletion mechanism. Deleting account state also removes the snapshots.

## OPFS SQLite layout

`SqliteRowStorage.ts` owns three tables:

- `smithers_collection_rows(collection_id, row_key, version_key, value)`;
  primary key `(collection_id, row_key)`.
- `smithers_metadata(key, value)` for schema/import bookkeeping and
  non-collection storage keys.
- `smithers_row_quarantine(...)` for rejected rows and pre-normalization originals.

`beginBatch()` buffers the coordinator's synchronous row deltas.
`commitBatch()` schedules exactly one `BEGIN IMMEDIATE` transaction that
inserts, updates, and deletes all changed rows; any error rolls it back.
A dispatch's receipt, `transaction.isPersisted.promise`, resolves only after
`flush()` completes.

At open, every known row is JSON-decoded and schema-validated. Validation reads,
recovery copies, normalization, imports and version stamps share one
`BEGIN IMMEDIATE` transaction, including asynchronous validators. Another
writer cannot replace the checked source before the migration writes it.
Ordinary invalid
rows move to quarantine and leave the live table in one transaction. Execution
journal and lineage-retirement rows instead use `invalidRows: "refuse"`:
unreadable rows or mismatched row keys stop opening before their evidence can
be removed. A newer app schema throws `FutureSqliteSchemaError`; malformed
current, legacy or per-collection schema stamps also refuse upgrade instead of
being guessed as current. A malformed import-completion marker cannot restart
legacy import, and binary version/envelope metadata cannot masquerade as absent.
Live source rows are preserved on refusal.

Local, legacy and normalized SQLite paths use the same decoder output and
check row keys against that decoded value. Defaults and compatible
normalizations are committed before returning the store. A changed normalized
SQLite row first saves a verified `schema-normalization` recovery copy whose
`value` is JSON `{ versionKey, value }`: the original version key and the exact
original row JSON string. These copies are not invalid-row reports. An error
in a later row rolls back earlier normalization and copies too.

Stored schemas must be pure, JSON-closed, idempotent normalizers. Changed
output is decoded again from its JSON representation before committing; a
decoder that changes it again or rejects its own output refuses the whole
open rather than quarantining valid source data. Use an explicit versioned
migration for one-shot transformations. Dates, BigInts, non-finite numbers,
undefined values, cycles, accessors, hidden/symbol properties and sparse arrays
are not stored JSON values; the opener refuses instead of silently dropping
or converting them. An unchanged JSON value does not require a second decode.

The one-time importer reads both historical formats: the `smithers_kv`
envelope and the former `collection_registry` tables. It validates before
copying and leaves source tables untouched for recovery. It also reads the
pre-envelope per-collection keys in `smithers_kv`. Existing normalized rows
win; a current envelope is authoritative over older per-collection/registry
data, including when its collection is empty. Invalid legacy rows move into
quarantine. Import, quarantine, and the `legacy-import-complete` marker commit
in one transaction, so an interrupted import can retry and a later deletion
cannot resurrect a legacy row. Future schema versions and unreadable legacy
envelopes fail closed, preserving their sources.

## localStorage fallback

`TransactionalStorage.ts` stores a versioned `smithers-mvp.store` envelope.
A batch writes the new bytes to `.staged`, writes the live key (the commit
point), then removes `.staged`. On boot:

- equal staged/live bytes mean commit completed; the staged marker is cleared;
- different bytes mean commit did not complete; staged bytes are discarded;
- ordinary malformed rows are quarantined rather than adopted;
- unreadable app envelopes or authoritative journal/retirement rows refuse
  opening, before any staged cleanup or quarantine writes;
- future envelope versions refuse open before touching live or staged bytes.

A failed stage cleanup after the live write still reports a successful commit;
its matching stage is recoverable on the next open.

Legacy per-collection keys (or a historical version-zero envelope) are
migrated through the same schema registry. Every known collection is also
validated when opening a current envelope. Invalid rows retain their original
bytes in quarantine, while valid rows use the schema's decoded value. Legacy
host keys stay untouched as recovery copies; the committed current envelope
is authoritative on later opens, so removed rows remain removed. If migration
cannot commit, the original keys remain available for retry.

If decoding changes a valid row or strips extra row-envelope fields, the
current localStorage envelope is retained in full before it is rewritten.
Backup writes are read back and verified. Mutating validators cannot replace
the rejected row's recovery original. Observable source changes while an async
validator is waiting refuse open before replacement. That final comparison is
not an atomic cross-tab lock; concurrent independent stores still require an
ownership protocol.

Authoritative collections are the exception to generic row quarantine. Their
row IDs must agree with their storage keys, and any rejected row refuses the
whole open. Losing a replay prefix or retirement marker can make old work look
new; boot must not continue with a silently incomplete execution history.

If an earlier release already created a current envelope while skipping its
legacy keys, those keys remain recovery copies; automatic open cannot
distinguish skipped historical rows from rows intentionally deleted from the
current envelope and does not merge them back in.

For app-schema upgrades, `AppStore` preserves compatible older rows and stamps
the current schema only after the validated envelope commits. A future or
invalid app-schema stamp refuses open without changing stored bytes. The
standalone `enforceSchemaVersion` now defaults to read-only validation too:
an absent/older stamp waits for the validated opener to commit, and a newer
stamp refuses. Only explicit `onMismatch: "reset"` permits destructive reset
with recovery copies; app boot explicitly uses `onMismatch: "validate"`.

Recovery copies preserve every distinct rejected original. LocalStorage keeps
the first historical backup key and puts later differing originals under a
SHA-256-suffixed key; identical repeats reuse a saved copy. SQLite binds new
quarantine IDs to collection, row key and exact original bytes, and verifies
the saved copy before removing a source row. Existing older backup IDs remain.
A failed/conflicting backup refuses recovery rather than overwriting a saved
copy or discarding its source. Recovery copies are private local data, not
anonymized by their hashed keys; there is no automatic pruning.

Imports support the historical formats recorded in repository history; they
do not guess at arbitrary database layouts or transform incompatible records
beyond the current schema's decoder. Unknown collections stay in the original
source. Special tagged TanStack values that do not satisfy the current app's
JSON schemas are retained for recovery rather than coerced into another type.

## Private local recovery files

Run `/storage.recovery` to show the download step inside the conversation. The
startup-failure panel offers the same action before AppStore is available.
Both invoke the `storage.recovery.export` Flow. Its browser gesture is
human-only; the agent may offer the prompt but cannot execute the raw download,
even through a direct binding. Nothing in the file enters model/tool results,
the transcript, operation status, or an HTTP upload.

The warning matters: a file can contain private conversations, authored notes,
quarantine copies, and older account data. Keep it local. The filename is
`smithers-local-recovery.json`; “download prepared” means a browser handoff,
not proof the human saved a file. Capture/download failure is visible, safe to
retry, and never clears the source. Closing the owning panel/controller
suppresses a late download and releases its subscription and object URLs.

The versioned JSON artifact contains raw localStorage keys from only the live
and quarantine namespaces, plus table schemas and typed SQLite cells when an
existing database is accessible. Integers use decimal strings; blobs and
invalid UTF-8 use tagged hex. Sources remain separate: capture does not choose
or merge unstamped histories. `session` names the exporting session's backend
or `unopened`, `memory` separately contains a degraded session's unsaved keys,
and `unavailable` explicitly names APIs the browser cannot offer. No `sqlite`
field with an available API means no database existed at inspection time.

A live SQLite store exports on its owning connection, serialized between
writes. After failed boot, recovery checks for the existing database before
opening it and never runs application migrations or schema validation. This
is not a filesystem-read-only open: the vendor VFS may manage temporary files
or SQLite journals. It does not protect against another tab deleting the file
between inspection and opening. Observable localStorage changes across capture
refuse the result, but there is no cross-backend atomic snapshot or cross-tab
lock. A source read failure refuses the download rather than silently omitting
that source.

Limits are 64 MiB encoded output and 128 SQLite tables. No partial/truncated
file is produced. This is a logical data-recovery dump, not a byte-for-byte
SQLite backup: physical rowids and all index/trigger/extension layouts are not
preserved. There is no automatic restore, backend chooser, or streaming/native
large-export path yet. Recovery also needs the app's recovery bundle and an
answering storage worker; a never-answering worker remains a lifecycle limit.

## Recommendations

The `app-recommendations` collection persists one `current` row validated by
`RecommendationSchema` in `src/mainview/state/AppState.ts`. It contains ordered
flow bindings, their source (`rule` or `agent`), the session revision and a
creation timestamp. `src/mainview/state/controller/recommend.ts` dispatches
`recommendations.updated` with the rule's suggestions first, then a validated
server answer when available. `App.tsx` projects the stored suggestions; before
that row exists it uses the repository-step fallback. Reload retains the last
recommendation while regeneration is pending.

## Retention

Diagnostic compaction is part of the same dispatch as the append. The store
keeps the newest 500 transition records and 250 tool-call records. Entity
collections and authoritative `chainEvents` are not time-trimmed. Both active
and completed chain journals must retain their full prefixes: without them a
resume can repeat model calls or external effects. Clearing/archiving a chat
does not delete that execution evidence.

Account sign-out, expiry and replacement scrub private journal contents,
transcript cards and snapshots, composer drafts, deferred commands,
recommendations, billing, repository inventory, working copies, cloud
workspaces, integration status, and repository tree and flow projections.
Card tabs and cloud terminal tabs close. Search history and repository selection
reset. Local World notes and local host resources remain machine-owned.

The identity row persists `accountOwnerLogin` independently of availability.
An unavailable answer retains that owner and its data, including across reload.
A definitive sign-out or different login scrubs in the same transaction that
publishes the new identity. Missing ownership on a legacy unavailable row is
unknown, so the next definitive answer scrubs conservatively. Fresh anonymous
sessions retain deferred sign-in intent until their first login.

The same transaction now inserts permanent SHA-256 lineage-ID tombstones in
`app-retired-chain-lineages`. Those IDs cannot be resumed or reused, including
after reload or another sign-out; a new account needs new lineage IDs. The
tombstone contains no goal, script, call data, account name or raw lineage label.
It is a replay-safety key, not encryption/anonymization of a guessable label.
Schema version 11 adds this collection; older compatible rows are preserved,
and schema-aware older builds must refuse the newer store rather than ignore
retirements. Do not downgrade through a build that resets unknown schemas.

There is no ordinary chain-journal garbage collector in 1.0. A future archive operation
must retain replay checkpoints/results and non-reusable lineage tombstones
before removing events; a global row/age cap is not such a protocol. Until
then journals consume storage. Quota/write failures reject appends rather than
discarding old evidence. Missing prefixes, sequence gaps and duplicate
positions fail journal reads/appends; data already completely lost by an old
build cannot be reconstructed or distinguished from a new lineage here.

CollectionJournal honors expected-position appends and shares a commit lock
among adapters over one AppStore. Reads wait for its pending journal writes to
commit or roll back. A started persistence commit is not cancellable, so its
lock survives caller interruption until the receipt settles. Independent
AppStores/tabs still need single-writer ownership of each lineage; the adapter
does not claim a cross-tab/database lease or exactly-once external effects.

## Verification

- `SqliteRowStorage.test.ts`: normalized rows, atomic commit/rollback,
  validation, quarantine, legacy import, and future-version refusal.
- `TransactionalStorage.test.ts`: staged-write crash recovery and migrations.
- `DurableCollection.test.ts` and `Persistence.test.ts`: failed-write rollback,
  stale optimistic state rejection, independent overlapping SQLite commits,
  direct collection writes, and query metadata during pending persistence.
- `AppStore.test.ts` and controller suites: reducer projections and retention.
- `e2e/playwright/frames.spec.ts`: durable frame URL/history/reload behavior.
- `StorageRecovery.test.ts`, `BrowserStorageRecovery.test.ts`, and
  `RecoveryIntegration.test.ts`: raw capture, host cleanup, actor refusal, and
  private bytes absent from the real controller's results/transitions.
- `StartupRecovery.test.ts`: failure/retry and cancellation of the non-React
  projection, including a failed recovery-bundle load.
- `e2e/playwright/storage-refusal.spec.ts`: physical OPFS refusal/reopen,
  unstamped legacy adoption/ambiguity, and actual recovery downloads from both
  failed boot and a running app.
