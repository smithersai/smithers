---
"@smthrs/merge-queue": minor
---

A fixed change re-queues at the back of its priority with a new arrival number, so it no longer jumps ahead of the
runs already in flight and stalls them. At a 5% failure rate the benchmark's landing rate on 64 CI slots rises from
6.3 to 12.2 changes per CI duration.
