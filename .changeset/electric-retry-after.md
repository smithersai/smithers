---
"@smthrs/effect-electric": minor
---

An Electric collection waits at least a failed response's `retry-after`
before it sends the request again. The default policy retried a `503` with
`retry-after: 5` after about 1, 2 and 4 seconds, each request sent before the
server was ready. `ShapeSource.RequestFailed` carries the delay as
`retryAfterMs`; `SyncPolicy.retryAfterMs` reads the header (delay seconds or an
HTTP date, at most `SyncPolicy.MAX_RETRY_AFTER_MS`, 1 minute), and
`SyncPolicy.respectingRetryAfter(schedule)` applies the floor to any schedule.
`reconnect` still ends the wait at once.
