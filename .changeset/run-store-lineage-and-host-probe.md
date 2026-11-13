---
"@smthrs/run-store": major
"@smthrs/platform-node": minor
"@smthrs/cli": patch
---

Run creation now rejects missing lineage roots, parents outside the lineage,
and non-increasing rounds with `invalid_run` before inserting a row. A root
without lineage metadata counts as round zero.

`RunStore.owned` accepts `inProgressStates`, defaulting to `["running"]`.
Pass the same policy used by `AttemptStore.layerWith` so custom active states
admit fenced application writes.

Move `Ownership.sameHostPidProbe` out of `@smthrs/run-store`. Import
`HostLiveness.sameHostPidProbe` from `@smthrs/platform-node` instead. There is
no forwarding export. `HostLiveness.isAlive` and the moved probe share one
implementation, with explicit cross-host and same-pid policies; their existing
caller behavior is preserved.
