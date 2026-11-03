---
"@smthrs/database": patch
---

A lone plain `SELECT` of the engine's `flows_*` tables now names their schema in
its text and runs as one round trip, in place of `BEGIN`, the schema, the
statement and `COMMIT`. One TODO alarm made 31 such reads. Anything the rewrite
can't prove to be one plain read of those tables stays framed as before.
