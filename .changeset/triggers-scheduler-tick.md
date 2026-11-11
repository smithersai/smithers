---
"@smthrs/triggers": minor
---

Add `Scheduler.tick`: one whole scheduler tick for a host that keeps no process between ticks, such as a durable flow step on Cloudflare. It takes the previous tick's watermark as `since`, answers the next one, and returns once its launches are recorded.
