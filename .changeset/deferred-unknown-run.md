---
"@smthrs/engine-store": patch
---

A durable deferred completed for an execution that has no run is `NotFound` and stores nothing. The SQL store used to die with `FOREIGN KEY constraint failed`, and the memory store with a run view accepted the row. `DeferredPersistence.deferredDone` logs `engine-store.deferred.unknown-run` and journals and resumes nothing; `CompleteDeferredOutcome` gains `NotFound`.
