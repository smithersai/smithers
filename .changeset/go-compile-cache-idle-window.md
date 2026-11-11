---
"@smthrs/build-cli": minor
"@smthrs/build": minor
---

`cache prune --max-size` takes `--keep-used-minutes <n>` (default and minimum 60): Go compile cache entries used within the window are kept even when no running target holds them, which protects a `go` that `smthrs` did not start in the same directory. `CacheAdmin.remove` accepts `keepUsedWithinMs`.
