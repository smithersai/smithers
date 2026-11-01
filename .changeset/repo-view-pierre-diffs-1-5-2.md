---
"@smthrs/repo-view": patch
---

Pins `@pierre/diffs` at 1.5.2, up from 1.3.6. The views gain pierre's fixes since 1.3.6: both grammars load for a
diff that renames a file across languages, patch file names parse safely, blank-line changes keep their positions,
and `CodeView` scrolls and anchors more reliably.

The code view's worker pool lets pierre settle its startup: the 15-second `CODE_VIEW_POOL_DEADLINE_MS` is pierre's
`workerInitializationTimeout`, and the pool waits on pierre's `initialize()` instead of polling it every 50 ms. pierre
hands worker errors to the pool's `onWorkerError` instead of logging them, so a page that falls back to the main thread
logs one warning, and that warning names the reason.
