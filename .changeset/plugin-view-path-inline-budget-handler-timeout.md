---
"@smthrs/plugin": minor
---

A view's `path` is empty or a `RelativePath` of at most 128 characters, so `Host.pathOf` stays under the plugin's own
`/app/<plugin>/` or `/<owner>/<name>/-/<plugin>/`, and two views of one plugin with the same `scope` and `path` refuse
`conflict`. `Load.load` resolves every schema of a manifest against one `JsonSchema.budget()` of
`JsonSchema.maximumInlinedBytes` (65,536) inlined bytes and refuses `invalid` past it, so repeated `$ref`s cannot cost
seconds; `JsonSchema.resolve` takes the shared budget as an optional fourth argument. Every hook handler now has a
deadline: `Resolve.Options.handlerTimeout` (milliseconds, `Resolve.defaultHandlerTimeout` 30,000, at most
`Resolve.maximumHandlerTimeout` 600,000) fails a handler still running with `hook_failed` naming its plugin and hook, so
a stalled `config` or `configResolved` handler no longer hangs `Kernel.make`.
