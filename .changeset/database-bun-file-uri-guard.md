---
"@smthrs/database": patch
---

`BunDatabase.layer` refuses a 0.x `smithers.db` named by a `file:` URI. Under
Bun the guard used to look for a file literally named `file:...`, found none,
and let the client open and migrate the 0.x database. `file:<path>`,
`file://<path>` and `file:<path>?mode=rw` now fail with
`unsupported_database_file`, as a plain path and `NodeDatabase` already did.
