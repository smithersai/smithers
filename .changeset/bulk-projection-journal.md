---
"@smthrs/journal": patch
---

`Journal.Service.heads?` reads committed sequence tails and rewind generations together for a set of runs on SQLite and PostgreSQL, in batches of 2,000 IDs.
