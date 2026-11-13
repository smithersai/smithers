---
"@smthrs/flow": patch
---

A `DurableQueue` handler that exits with interruption alone is run again by the item's `handle` step, from half a second
up to a minute between tries and without a limit. The step no longer ends interrupted, which settled the item's
execution as cancelled: every redelivery then replayed the cancellation without running the handler, and the worker took
the item again in a tight loop.
