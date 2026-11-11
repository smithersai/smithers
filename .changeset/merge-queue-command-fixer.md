---
"@smthrs/merge-queue": minor
---

`CommandFixer`: fix agents as one process per change being fixed, briefed and answered through files. With
`FileInbox`, `JjRepository` and `CommandCi` the queue now runs end to end with no in-memory service.
