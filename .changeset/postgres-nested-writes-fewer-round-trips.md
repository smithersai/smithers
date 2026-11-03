---
"@smthrs/database": patch
---

Nested writes on PostgreSQL cost fewer round trips. Consecutive savepoints with no
statement between them now share one, and `WriteOptions.readOnly` marks a nested
write that only reads, which takes its lock and opens no savepoint.
