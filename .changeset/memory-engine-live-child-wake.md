---
"@smthrs/engine": patch
---

`FlowEngine.layerMemory` re-drives an execution when a completion lands while
its round is still running and that round then parks. A child flow that awaited
a `DurableDeferred`, `DurableClock`, `WaitFor` or `HumanTask` beside a running
sibling action used to park with the completion already recorded, and
`Flow.execute` on its parent never returned. Root executions no longer wait for
the next follower poll to receive such a wake.
