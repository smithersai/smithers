# @smthrs/memory

## [Unreleased]

### Changed

- `RecallSemantic.Vector` and `ProjectionInput` now require `recordKind` and
  `recordId` and no longer carry `key`; the SQL vector upsert keeps the newest
  row by `updatedAtMs`, so a late projection cannot replace a newer one.
- Semantic projection is bounded by `Options.projectionTimeout` (default
  5 seconds); a hung embedding provider is logged and dropped instead of
  stalling the decorated write.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added the durable memory store: namespaced facts with TTL, message threads
  and history, notes with supersession, SQLite full-text search, and the
  authoritative search rows every recall binding ranks.
- Added three recall bindings behind one replaceable slot: keyword, SQLite
  full text, and in-process semantic with vector projection.
- Added the callable `remember` and `recall` flows, the `WithMemory` policy a
  whole flow tree inherits, and `MemoryTrellis` for delegated plans.
- Added `Maintenance.ttlGc`, `limitHistory`, and `compact` as finite Effects
  intended for explicit schedules.
- Added `Source`, the memoized advisory snapshot an agent's opening context
  reads, and the `SnapshotRecorder` port that makes that snapshot durable
  across a resumed process.
- Added `Bank.parse`, the validating bank-name reader, and the public
  `Database` port `makeSqlVectorStore` accepts, so no public signature names a
  blocked `internal/*` type.
- Added the package's documentation site, https://memory.smithers.sh: an
  installation page, a quickstart, concept pages for durability, recall, and
  policies, task guides, a full API reference, an import-surface page, and a
  troubleshooting page keyed by failure code.

### Changed

- Semantic recall now lists only vectors stored under the model it was asked
  for, skips a row whose stored content digest no longer describes its text,
  and no longer fails a whole call because a foreign model appears in the
  namespace. The authoritative store writes no vectors of its own; projection
  is opt-in through `RecallSemantic.decorateStore`.
- Message ids are unique within a thread rather than globally, so a host that
  mints per-thread ids no longer loses every message after the first thread. A
  database carrying the old global key is rebuilt on open.
- TTL garbage collection now removes the expired fact, its full-text
  projection, and its vector rows in one transaction.
- Full-text backfill now indexes the same extracted text live writes index, so
  a fact is searchable by the same terms whichever side of `enableFts` it was
  written on.
- `putFact` serializes the caller's value once and derives the stored JSON, the
  search text, the retained tags, and any projection from that one snapshot.
- `putNote` treats the requested supersession set as immutable creation data
  and no longer compares the mutable `status` field, so a correct idempotent
  retry after a status change succeeds.
- `createThread` performs its insert, conflict check, and read back inside one
  transaction, so a failed read can no longer leave a committed thread the
  caller believes was never created.
- `recall` declares the `sealed` tier it actually needs, so a read-only recall
  nests inside a sealed or compensable envelope.
- `Flows.remember` validates tags against the package tag vocabulary, accepts a
  TTL, and records supplied provenance. Provenance is bound when a host builds
  the handler, through `Flows.runRememberWith(provenance)` or a second argument
  to `Flows.handlersFor`, so every runtime handler stays one-argument and binds
  to `FlowBinding.make` as-is.
- A read `limit` counts rows that pass every filter, not rows the query touched.
  Status and supersession are answered in SQL, and a tag-filtered read walks the
  namespace in bounded pages, so `listNotes`, `searchRows` and `searchFts` no
  longer return short answers while matching rows remain. `searchFts` resolves
  its ranked matches by id instead of through a recency window.
- Recall inputs carry published ceilings on bank count, bank name length, query
  bytes, `maxTokens`, and tag-group count; tag groups carry a depth and node
  bound and are matched iteratively; and recall de-duplicates on the resolved
  namespace, so aliased bank names no longer multiply results or scans.
- `withMemory` decodes, detaches, and deep-freezes the policy it attaches.
- Argument failures now return `invalid_argument` with a path to the offending
  field, distinct from the `store` code a backend failure returns. Added
  `idempotency_conflict` and `vector_model_mismatch`. Every id conflict answers
  `idempotency_conflict`, `createThread` and `compactMessages` included, so a
  replaying caller can tell a landed retry from a broken backend.
- Content digests use the repository's SHA-256 digest rather than a 32-bit
  hash, and persisted vector bytes are written explicitly little-endian.
