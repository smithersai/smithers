---
"@smthrs/platform-node": patch
---

Remove the obsolete write-grant widening check after sandbox planning. The
planner already rejects file writes and keeps each directory grant exact.
