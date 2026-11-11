---
"@smthrs/build-cli": minor
"@smthrs/build": minor
---

The build system owns Go's compile cache. Every tool a target spawns, and every `go` the planner starts, runs with `GOCACHE` set to `go-build` inside the workspace cache directory instead of the host's `~/.cache/go-build`; a target that declares `GOCACHE` in `env` keeps its own. `cache status` reports the directory, entry count and size in a new `goBuild` field. The value is set at spawn and is not key material, so no result is re-keyed.
