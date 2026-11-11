---
"@smthrs/merge-queue": minor
---

`QueueFlow.Queue` runs the queue as a durable flow: one recorded action per round, the queue's next position as the
next round's payload, and a failed round retried without end. Bisection now uses every free CI slot. The kernel
remembers the ready order per change list, which makes large queues about ten times faster. `scripts/benchmark.ts`
measures landing rate against arrival rate on a virtual clock.
