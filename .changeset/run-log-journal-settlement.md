---
"@smthrs/control": patch
"@smthrs/cli": patch
---

Keep the control journal's recorded run status alongside observed engine status.
Run log following waits for that recorded terminal transaction before its final
drain, so cancellation does not lose its last control event.

A terminal engine whose recorded local writer is proven dead drains and exits
without writing a replacement event. Live or uninspectable writers keep the
committed-state wait.
