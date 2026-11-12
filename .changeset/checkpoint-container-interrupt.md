---
"@smthrs/std": patch
---

A container checkpoint checkout now runs where an interrupt reaches it, under a
ten-minute limit and a bounded capture, and the release removes whatever an
interrupted checkout left. A `bash` call at a checkpoint whose command, script,
argument or environment names the workspace root by absolute path outside the
checkout (`cd /testbed && pytest`) is refused with `OutsideTree` instead of
running against the live tree under the checkpoint's name.
