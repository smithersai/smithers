---
"@smthrs/fs": patch
---

Distinguish malformed command argument text from resource bounds. NUL and unpaired surrogates now produce parse_failed with an argument path, including in flag parsing.
