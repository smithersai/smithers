---
"@smthrs/control": patch
"@smthrs/cli": patch
---

Keep the control journal's recorded run status alongside observed engine status.
Run log following waits for that recorded terminal transaction before its final
drain, so cancellation does not lose its last control event.
