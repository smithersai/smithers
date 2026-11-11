---
"@smthrs/patterns": minor
---

`Saga.run` takes an optional `uninterruptible` flag on each step. A flagged
step runs its action and registers its compensation as one uninterruptible
unit, so a saga cancelled while the action runs waits for it and then
compensates it. Before, a step whose action finished while an interrupt was
pending was never compensated.
