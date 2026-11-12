---
"@smthrs/build-cli": patch
"@smthrs/build": patch
---

One slow `findMissing` batch no longer disables remote cache publication for the rest of the run. A probe that outlives
its deadline is tried three times, then only that entry's publication is skipped with one warning; three entries in a
row that lose their probe this way, with no answered probe between them, still disable the remote. A `429` on an
artifact download, upload, or `findMissing` is now retried with jittered backoff within 8 seconds before it costs that
entry, so one busy moment no longer turns a restore into a rebuild.
