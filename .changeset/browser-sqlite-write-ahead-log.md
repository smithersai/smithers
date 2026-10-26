---
"@smthrs/platform-browser": minor
---

`BrowserSqlite` keeps each database on the access-handle pool in a write-ahead log under an exclusive lock (`locking_mode = EXCLUSIVE`, `journal_mode = WAL`, `synchronous = FULL`). A commit appends to the log and flushes it once, where the rollback journal created, flushed and deleted a journal file around every commit; a cold app start's 680 transactions take a third of the time. The `Sqlite` service gains `exclusive`, which `layerSqlite` sets: a VFS whose files several connections share leaves it unset and keeps SQLite's rollback journal. A database converted to the write-ahead log can't be opened by 1.0.0-rc.16 or earlier, whose worker then runs on memory with the device's data intact.
