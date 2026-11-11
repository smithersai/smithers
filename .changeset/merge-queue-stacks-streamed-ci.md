---
"@smthrs/merge-queue": minor
---

A change may be a stack of commits: register a jj revset and the stack is rebased, tested and landed whole.
`JjRepository` takes a `finish` command that runs on each rebased change, may resolve conflicts and add regenerated
files as commits, and names the commit that is tested and landed. `CommandCi.streamed` runs one process per CI run
and reads a `<check> pass|fail` line as each check finishes. The host flow reads `MQ_RUN_COMMAND`,
`MQ_FINISH_COMMAND` and `MQ_JJ`.
