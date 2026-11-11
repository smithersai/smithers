---
"@smthrs/targets": patch
---

Confined reads no longer fail on a file with several hard links when another checkout replaces one of them, which
moves the file's `ctime` without changing its content or its link count.
