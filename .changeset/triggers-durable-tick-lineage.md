---
"@smthrs/triggers": minor
"@smthrs/cli": patch
---

`Scheduler.layer` ticks on the flow engine's durable timers instead of a fiber it forked: the `Scheduler.Tick` lineage runs one tick per round, sleeps for the poll interval on a durable clock, and hands off with the watermark in its payload, so a host that restarts under the same name joins the lineage it left. The layer requires the host's `FlowRuntime`, `Digest` and `SecureRandom` beside the runner and the store. `NodeControl.layer` and `NodeControl.layerControl` provide the engine's `FlowRuntime` beside `Control`, which `smthrs serve` and `smthrs triggers serve` tick on.
