---
"@smthrs/targets": patch
---

Confined reads no longer fail when another checkout sharing a package store makes or removes a hard link to a file
being read, which moved its `ctime` and failed declaration loading with "changed while it was being opened".
