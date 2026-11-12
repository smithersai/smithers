---
"@smthrs/time-travel": minor
---

`MemoryTimeTravelStore.archiveAndTruncate` now fails closed like the SQL store:
a run with no recorded owner is refused with `fence_lost` instead of truncated
under any owner. `TimeTravel.rewind` activates its own owner through the
`RunStore`, so a test that rewinds over the memory store passes that run store
in the new `runs` option, and the fence reads the owner its row records:

```diff
- const store = MemoryTimeTravelStore.make({ records })
+ const store = MemoryTimeTravelStore.make({ records, runs })
```

A test that calls `archiveAndTruncate` directly can name its owner in
`runOwners` instead.
