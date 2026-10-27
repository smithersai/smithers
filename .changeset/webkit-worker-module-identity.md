---
"@smthrs/platform-browser": patch
---

Keep browser worker composition in one static module graph. WebKit can evaluate a worker entry twice when a lazy engine chunk imports back from it, mixing Effect Schema's private sentinel identities and refusing durable action results.

Add PendingSnapshot for synchronous tab-scoped staging until a durable write receipt, including recovery after an immediate reload and protection against late acknowledgments.

Keep SQLite's API and VFS in the worker module graph. Add an Effect-native cached binary asset source so dedicated workers can reopen their pre-cached WASM without relying on service-worker interception; network cancellation propagates and reads retain sanitized telemetry.
