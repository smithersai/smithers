---
"@smthrs/flow": minor
"@smthrs/engine": patch
"@smthrs/engine-store": patch
"@smthrs/canonical": patch
---

Add `Action.StoredSerialization`, the context reference an engine sets to choose how action results are stored (VIP-44). Engines no longer provide the `RpcSerialization` service around a dispatch, so an action body sees the caller's `RpcSerialization`, not the store's. `sortCollections` ranks `-0` as `0`, matching its encoding. Uses the library catalog's `@smthrs/flow` entry.
