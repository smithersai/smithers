---
"@smthrs/std": patch
---

Process tools reject non-finite, non-positive, or over-ten-minute timeouts before
starting a command. Shell output preserves both ends when capture fills and
discloses omitted bytes separately from display truncation. Pytest reports retain
failure names when a test prints a line beginning with `ok` or `not ok`.
