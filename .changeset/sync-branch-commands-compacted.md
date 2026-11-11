---
"@smthrs/sync": patch
---

`BranchCommands` admits commands on a compacted branch run. A process with no in-memory state for the branch, after a
restart or a `branchIdleMs` eviction, used to fail every `Branch.Submit` with `unknown` because its hydration read
started below the compaction floor. Hydration and the conflict-recovery reads now resume at the floor. An exact
retransmission of a command below the floor still receives its `duplicate` receipt from the journal.
