---
"@smthrs/platform-browser": minor
---

Follow durable runs with `BrowserEngine.runs({ flows, within })`: subscribe
before the initial snapshot, refresh after run events and leader changes,
and recover failed reads with bounded backoff. Completed runs remain visible
when their event arrived before the tab subscribed.
