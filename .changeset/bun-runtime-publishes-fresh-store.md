---
"@smthrs/platform-bun": patch
---

`BunRuntime` builds a fresh SQLite store the way `NodeRuntime` does: privately, migrated in one durable write, flushed, and published with an exclusive hard link. A Bun host killed during its first start no longer leaves a partly initialized `engine.db` at the published name, and two Bun hosts starting cold on one path converge on one store.
