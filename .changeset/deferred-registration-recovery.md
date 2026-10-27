---
"@smthrs/engine-store": minor
"@smthrs/flows": patch
"@smthrs/platform-node": patch
---

`EngineStore.Options.deferRecovery` recovers every registration made before the host's first `Driver.reportRecovery` together, in that report: one read of the pending clocks and one of the unconsumed completions for all of them, instead of one of each per registration. `Runtime.layer` and `NodeRuntime.layerHost` set it, since they report as soon as registration finishes and resume no run before. `DurableEngineState.completedDeferreds` lists every flow's completions when given no flow. A browser engine that registers 500 flows read its store 1,000 times before its first page; it now reads it twice. Uses the library catalog's `@smthrs/flow` durable engine entry.
