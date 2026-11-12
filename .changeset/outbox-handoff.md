---
"@smthrs/effect-tanstack-db": minor
---

`Outbox.handoff(idempotencyKey, accept)` takes a write back into a new durable home, such as a draft, without a window
in which neither holds it. Before the write leaves the storage it is parked with reason `withdrawn`, which also keeps it
from being sent; `accept` runs next, and its success deletes the parked copy. When `accept` fails or is interrupted, or
the program stops first, the write stays parked and `Options.parked` takes it as the outbox next starts.
