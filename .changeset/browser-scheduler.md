---
"@smthrs/platform-browser": minor
---

`BrowserScheduler.make()` is Effect's `MixedScheduler` dispatching fiber work as messages on a `MessageChannel` instead of `setTimeout(f, 0)`, which a browser holds to 4 ms once nested five deep. `BrowserRuntime.run` and `BrowserLanguageServer.serve` run their workers on it. A cold browser engine that registered 500 flows spent about 900 ms of its start idle in those holds; its device store now opens about 900 ms sooner. Uses the library catalog's `@smthrs/platform-browser` entry.
