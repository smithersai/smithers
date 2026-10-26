---
"@smthrs/plugin": minor
---

`PluginHost.dispatch` answers `Dispatched` with `settled`, which waits for the run's end: `Settled`, a schema of
`{ _tag: "Done" }` or `{ _tag: "Failed", code }` with the failure's stable code, never its message. A view can say a run
failed, why, and offer to run it again. A host implementing `PluginHost` must fill it.
