---
"@smthrs/build-cli": patch
---

`Go.ModDownload` of a module that requires nothing now succeeds. `go mod download` writes no module cache entries for such a module, and the runner rejected the empty output directory with "did not produce declared outputs". The planner now admits an empty module cache only when the `go.mod` that `go` reads has no `require` directive; any other empty output directory still fails.
