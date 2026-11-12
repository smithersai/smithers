# @smthrs/step-cache

## [Unreleased]

### Fixed

- `sweepExpired` refuses a bound left out. An `olderThanMs` a JavaScript caller
  or an unset configuration value passed through a cast omitted made a `NaN`
  floor, which deleted nothing on SQLite and would delete every head on
  PostgreSQL; it now fails with `invalid_cache` like a negative bound.

- Shared-cache reads now import only the reusable head. A shared entry
  claiming a local event's identity can no longer create immutable history
  that conflicts with the event's real recording or survives head eviction.

- The CommonJS build of `Migrations` no longer reads the migration module's
  whole exports object in place of its Effect. esbuild compiles a default
  import of a sibling under `"type": "module"` to Node-style interop, so
  `set.migrations["0001_initial"]` had no `pipe` in `dist/cjs` and every
  `require` consumer failed at schema time. `migrations/0001_initial` now
  exports the named `initial` binding and has no default export.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Extracted the durable step-result cache from `@smthrs/journal`, including
  SQL migrations, metrics, local/remote composition, and a Node test layer.
- Added immutable provenance reads, age-bounded lookups, fenced eviction, and
  explicit inline or deferred remote publication.

### Changed

- Canonicalized stored results and enforced bounded, inert JSON snapshots at
  every local and remote boundary. A `result` or `meta` past four MiB, depth
  128, or 100,000 nodes or members now fails with `invalid_cache`.
- Restricted cache keys to a URL-safe grammar and made malformed inputs fail
  before SQL or HTTP I/O. A key outside `[A-Za-z0-9_-]{1,256}` that a previous
  build accepted now fails with `invalid_cache`.
- A `put` reusing a provenance the ledger already holds now resolves `Conflict`
  whenever its `result`, `meta`, or `createdAtMs` differ, where it previously
  resolved `Inserted` and split the head from the recorded evidence.
- `RemoteCacheStore`'s `requestTimeout` is one budget for a whole operation,
  its request and its response body together, rather than one budget per phase.
- Documented that `flows_step_cache_recorded` is append-only with respect to
  this package alone: `@smthrs/engine-store`'s retention deletes ledger rows by
  `recorded_run_id`, and rows a shared-tier write-back landed under a foreign
  run id are never reclaimed.
- `CombinedCacheStore` counts a shared-tier `Conflict` on
  `CacheStoreMetrics.put.Conflict`, so cross-host divergence reaches an
  operator instead of being discarded with the shared outcome.
- `validateRecordedBy`, `validateFence`, and `validateAge` now resolve to the
  value they checked rather than to `void`, and both tiers read each option
  through that returned value. Every operation option is therefore decoded once
  and never reread from a caller's accessor.
- `snapshotEntry` freezes the entry schema decoding produces, not only the
  provisional object it decodes.

### Fixed

- A fenced `evict` can no longer degrade into an unconditional delete. Both
  tiers read `ifRecordedBy` once, so an options object whose accessor answered a
  valid fence to the validator and `undefined` to the statement no longer drops
  a row recorded by another run, and no longer sends an unfenced `DELETE` to a
  shared tier. `maxAgeMs` and `recordedBy` are read the same single way.
- `CombinedCacheStore.put` can no longer publish a different value than it
  persisted. The entry it forwards to both tiers is frozen at every level, so a
  local tier that mutates the shell between the two writes cannot change what
  the shared tier receives.

### Security

- Bounded remote request lifetimes and response bodies, rejected unsafe
  endpoints and headers, and prevented rejected payloads or transport causes
  from entering diagnostics.
