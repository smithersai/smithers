---
"@smthrs/testing": major
---

`HttpRecording.load`, `record` and `make` now require `FileSystem.FileSystem | Path.Path` in their Effect environment; `HttpRecording.layer` requires the same input services. The module no longer imports Node filesystem or path modules. Root exports are unchanged, and `replay(recording)` remains independent of host services.

Node callers import `NodeHost` from `@smthrs/platform-node` and `Layer` from `effect`, then add:

```ts
Effect.provide(Layer.mergeAll(NodeHost.NodeFileSystem.layer, NodeHost.NodePath.layer))
```

Provide the corresponding Bun host layers on Bun. For `HttpRecording.layer`, use `Layer.provide` with the same host layers.
