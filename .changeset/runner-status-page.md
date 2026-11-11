---
"@smthrs/cli": minor
---

`smthrs runner status --port <n>` serves the workstreams as one self-contained page on `127.0.0.1:<n>`, with
`GET /workstreams.json` beside it. Each request reads the lanes' runs again; the page reads it again every 15 seconds.
