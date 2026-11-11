---
"@smthrs/merge-queue": minor
---

New decision `probe`: with a spare run slot the queue tests each ready change alone on the tip, so a failing change is
found and sent to a fix agent before it reaches the front of the queue. A pending probe never holds the queue. At a
10% failure rate the benchmark's landing rate on 64 CI slots rises from 6.5 to 20.5 changes per CI duration.
