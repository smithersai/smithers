---
"@smthrs/cli": patch
---

Following a run costs the same however many of its rounds have ended. The control projection no longer reads the
journal of a round that had ended and was drained, until a rewind reopens it or ends it again.
