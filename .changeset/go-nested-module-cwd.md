---
"@smthrs/build-cli": patch
---

Go rules run in the declared module's directory. A workspace whose
`S.Go.Toolchain` names a nested `go.mod` (`//typescript/tsc/go.mod`) planned
against that module but spawned `go` at the workspace root, which failed with
`go.mod file not found` (`Go.Binary`, `Go.Test`) and `no modules specified`
(`Go.ModDownload`). `./` and `//` package patterns, `Go.Binary` `out` and the
`Go.Lint` config now resolve against the module directory; a directory pattern
outside the module refuses the target. A module at the workspace root plans
exactly as before.
