---
"@smthrs/merge-queue": minor
---

The queue is rebased on the tip of the target and never blocks. Landing is two steps: `push` decides to fast-forward
the target onto a tested green tree, and `land` records it only when the target is seen there. A commit someone else
puts on the target is a `foreign` event: every run on the old tip dies and the stack is rebuilt on the new tip and
tested again. New `Driver.round` runs the queue against the world through the `Inbox`, `Ci`, `Fixer` and `Target`
services; every command is a reconciliation derived from the state, so a crash anywhere repeats safely.
