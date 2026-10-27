# 0120 — Flow editing when device storage is unavailable

2026-10-27. Updates decision 0092's storage-admission policy.

A browser that cannot open device storage still allows editing for this page's
session using the existing in-memory collection fallback. The form, answers and
code say **Not kept on this device**. A failed restore of an opened store still
refuses edits: it must not overwrite retained text. Session-only edits never
replace existing device rows. Durable actions still require an available engine;
this decision does not claim persistence or offline execution where none exists.

An immediate manual reload can precede the last SQLite write receipt. At the
input boundary, the new-flow form stages its current value in tab-scoped session
storage through `@smthrs/platform-browser`'s `PendingSnapshot`. Restoration checks
its schema and tab id, applies it after device restore, and removes it only after
the corresponding device receipt. A late receipt cannot clear a newer input.
Sign-out clears the staged value. If session storage refuses the snapshot, the
visible session editor still works; no reload-retention claim is made for it.

The WebKit device preparation failure was a worker module identity bug: a lazy
engine chunk imported its worker entry back, and WebKit evaluated that entry a
second time. Effect Schema's private missing/same-result sentinels crossed those
two instances. Encoding a finite epoch then yielded `"Symbol()"` and SchemaError.
The browser SDK now composes its worker statically. SQLite and OPFS need no
WebKit-specific schema, migration, or Atomics workaround.

Snapshots carry the verified device owner's namespace. An unverified, sealed or
changed owner cannot stage or restore another person's pending input; receipts
are compared with the owner still attached. This also fences a tab reopened after
another tab completed sign-out's wipe.

The offline follow-up found a separate host bug. With a controlled, pre-cached
shell and a real network disconnection, WebKit could reload the shell but its
worker's native SQLite asset fetch failed. The SDK now bundles SQLite's API/VFS,
the app binds its factory statically, and `BrowserCache.readAsset` reads the
cached WASM through an Effect-owned `BrowserSqlite.EffectBuild`. No nested Effect
runner or browser-specific app branch is needed.

Playwright WebKit's setOffline also prevents the controlled shell's cached fetch
and navigation in this environment. A real local server shutdown still serves
the cached shell, so the transport-emulation failure is recorded separately from
application storage behavior.
