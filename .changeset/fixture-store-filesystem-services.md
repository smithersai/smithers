---
"@smthrs/testing": minor
"@smthrs/platform-node": patch
---

The file fixture store now uses injected `FileSystem` and `Path` services, so its symlink protection runs through the real host filesystem and faults can be supplied without replacing Node modules.

`FixtureStore.makeFile(path)` and `FixtureStore.layerFile(path)` now require those services. Node callers import `NodeHost` from `@smthrs/platform-node` and add:

```ts
Effect.provide(Layer.mergeAll(NodeHost.NodeFileSystem.layer, NodeHost.NodePath.layer))
```

For a fixture layer, use the same host layers with `Layer.provide`.
