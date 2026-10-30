---
"@smthrs/agent": patch
"@smthrs/control": patch
---

Carry the durable delegation sequence to the executor and serialize its admission
per run. Concurrent approval callbacks and journal notifications consume one offer
once; stale delivery cannot wake a later unanswered park. Preserve engine wakes,
operator consent and durable resume intent until its admitted drive starts.
