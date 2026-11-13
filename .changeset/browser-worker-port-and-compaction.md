---
"@smthrs/platform-browser": minor
---

Add an optional `BrowserRuntime.run` worker port for injected message and error
event boundaries. The default still uses the dedicated worker global.

Shared tab connections now reject `VACUUM` with a named `VacuumUnsupported`
error that explains why compaction is unavailable, while preserving their
transaction and commit receipts.
