---
"@smthrs/flow": minor
"@smthrs/engine": minor
"@smthrs/engine-store": minor
---

Action results are stored in the representation Effect's `RpcSerialization` injects (VIP-44). `Action.executeEncoded` encodes successes and typed failures with `codecFor` of the `RpcSerialization` in context, defaulting to `RpcSerialization.json` (unchanged bytes), and the new `Action.exitSchemasFor(serialization, action)` gives the exit schemas that decode them. `FlowEngine.Encoded` gains an optional `serialization`; `FlowEngine.layerMemory` reads the serializer once when it is built and stores any serializer's results. `EngineStore.layer` stores the four serializers that share the JSON codec and refuses any other when it is built with the new `UnstorableSerialization` defect. Uses the library catalog's `@smthrs/flow` entry and Effect's `RpcSerialization`.
