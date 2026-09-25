# Bounded sealed Durable Object export

`MaintenanceExport` accepts the existing `binding`, `objectId`, and `migrationId`
request plus `page: { cursor: null }`. Send the returned opaque cursor for each
successor. Authorization, expiration, recipient and source-version checks apply
to every request. Cursors are encrypted and bound to that exact configuration.

Each response is `{ snapshot, cursor }`. The snapshot uses the existing
RSA-OAEP-256 + AES-256-GCM envelope, with authenticated metadata
`version: 2`, `schema: "smithers-do-storage-page/v2"`. It contains the execution,
binding, object, source revision/version and capture time, plus:

- One scan UUID, consecutive page indexes, and cumulative entry counts.
- `previousSHA256`: SHA-256 of the exact compact JSON of the preceding
  response's `snapshot` object. The first value is `null`.
- `complete`: an authenticated terminal marker. Only this page has a null cursor.
- `consistency` and the embedded fence identity, if the real `fencedDurable`
  class is serving. A client cannot select this by request or environment flag.

Each request reads at most 257 storage values, one at a time, and seals at most
256 entries and 1,000,000 plaintext bytes. Metadata and continuation sizes are
also bounded. An individual value that cannot fit returns
`413 snapshot_entry_exceeds_page_limit`; it is never skipped. The old single
snapshot route retains its original limits and schema.

`paged.ts` collects owner-only immutable page files and writes a per-object
`smithers-do-paged-archive/v1` manifest only after the terminal page validates.
It resumes an interrupted collection by reopening its complete retained prefix.
Validation checks every file digest/size, page chain, UTF-8 key ordering, count,
source identity, fence and terminal marker. Duplicate, missing, reordered or
foreign pages fail. It retains one page of plaintext at a time. Import callbacks
may stage rows, but must not commit until validation finishes. `openSnapshot`
continues to read v1 and deliberately refuses individual v2 pages.

An unfenced multi-request scan is **not an atomic snapshot**. Changes behind the
cursor can be missed, even when traversal reaches the end. Diagnostic collectors
report `globallyQuiescent: false` and `scanConsistency: "unfenced-not-atomic"`.
Final drain collection requires the actual object writer fence, its exact
execution/source identity, and separate global fence/drain evidence. Alarm or
marker changes between pages invalidate the scan and require a fresh one.

Keep the recipient private key outside the repository until the retained archive
has been replayed and its retention is explicitly decided. Ciphertext without
that key is not a replayable backup.
