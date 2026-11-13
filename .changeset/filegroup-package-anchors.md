---
"@smthrs/targets": minor
---

Expand default-cwd file groups from their declaring package, matching the files covered by the planner's cache key. Nested groups retain their own package anchors.

`Filegroup.Payload.sources` now accepts `Filegroup.AnchoredSource` entries (`{ base, source }`) instead of bare sources. `Filegroup.sources(attrs, context)` now requires a `Target.ImplementationContext` and returns anchored entries. Hosts constructing payloads directly must supply each source's declaring package directory as `base`, or `""` for workspace-relative sources. `Compose.AnchoredSource` remains available as an alias; `Filegroup.expand` retains its existing signature.
