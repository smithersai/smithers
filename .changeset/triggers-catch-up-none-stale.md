---
"@smthrs/triggers": minor
---

`catchUp: "none"` no longer fires a stale boundary. After downtime the scheduler fires the boundary it crossed only while it is younger than the new `Scheduler.Options.staleAfter` (`Scheduler.defaultStaleAfter`, five minutes; `Scheduler.layer` adds its `pollInterval`), so a weekly run no longer starts days late. A disabled trigger keeps its watermark moving, so enabling it again replays none of the boundaries it skipped while paused.
