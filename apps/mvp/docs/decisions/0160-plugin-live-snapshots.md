# 0160 · Stable snapshots for plugin subscribers

2026-11-04 · Implementation correction found by the external-page ship lane.

The app's implementation of `@smthrs/plugin`'s `Host.Live` must return the
same array while its rows are unchanged, as its React consumers use
`useSyncExternalStore`. TanStack's `toArray` allocates on every read, causing
Queue's navigation count to render indefinitely. The local external-page
journeys reproduced both the uncached-snapshot warning and maximum update
depth error, with `NavCount` identified by the existing render diagnostics.

Read the actual gated query synchronously on every call and retain the previous
array when all row references and their order match. Do not cache only the
asynchronous rows stream: permission refusals must hide rows in the same read.
Repository-scoped adapters also return a stable empty array while hidden.
The shared sentinel and adopted arrays are frozen, so an untyped consumer
cannot mutate another subscriber's snapshot.

The real-collection regression covers empty and populated identity, changed
rows, deletion, refusal and restore, including reads before yielding to the
stream. The browser's existing console-error gate remains mandatory.
