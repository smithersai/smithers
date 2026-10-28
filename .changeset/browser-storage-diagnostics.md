---
"@smthrs/platform-browser": patch
---

Record SQLite initialization by build, OPFS, database and journal stage, with a
bounded native error classification. Refused storage is distinguishable from a
failed SQLite asset without recording paths, SQL, error messages or content.
Cancellation has a separate outcome from storage failure.
