---
"@smthrs/cli": patch
"@smthrs/memory": patch
---

The Smithers host deletes expired memory facts on a durable poll. The executor
starts, or joins, one `smithers/memory/TtlGc` lineage on its flow engine: a
pass when the host starts and one every ten minutes, with the wait on the
engine's durable timer. The lineage's id names the build of its plan, so a
release that changes the plan starts its own lineage. A pass that fails or dies logs `memory TTL GC pass
failed` and the next one runs. `NodeControl.layerMemory` is the store alone.

`Maintenance.layerTtlGc` and `Maintenance.TtlGcScheduleOptions` in
`@smthrs/memory` are deprecated and go in the next breaking release. Run
`Maintenance.ttlGc` from a durable flow instead.
