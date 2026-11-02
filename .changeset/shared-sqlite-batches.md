---
"@smthrs/platform-browser": minor
---

`SharedSqlite.open`'s `Database` gains `executeBatch(statements)`: it runs the statements in order as one request to the leader, one round trip, and resolves with each one's rows. A batch commits only with its last statement, and a statement SQLite refuses fails it and runs none after it. A leader of an older build runs no batch, and the tab sends the statements one at a time. With the repository's TanStack DB patches, a persisted collection restores in about five requests instead of about 35.
