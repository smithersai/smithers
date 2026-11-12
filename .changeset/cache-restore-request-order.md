---
"@smthrs/build-cli": patch
"@smthrs/build": patch
---

Concurrent remote cache restores are admitted in the order targets asked for them. A chunked binary requested first no
longer waits behind every file of a large output requested after it, so the first target to ask finishes first instead
of every target finishing together at the end.
