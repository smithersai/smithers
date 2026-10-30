---
"@smthrs/cli": patch
---

Keep native health discovery registered until its probes finish shutting down,
so due timers do not produce unregistered-flow warnings during host teardown.
