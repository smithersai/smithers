---
"@smthrs/build-cli": patch
---

Editing only a `_test.go` file no longer changes a `Go.Binary` key. Its closure
digested every package's test files although `go build` never reads them, so a
test edit rebuilt the binary and every target downstream of it. `Go.Test`,
`Go.Fuzz`, `Go.Generate` and `Go.Packages` still key on test files, and
`Go.Generate` and `Go.Packages` now key on test-only imports too: `go generate`
scans test files, and a selection's consumer may test it.
