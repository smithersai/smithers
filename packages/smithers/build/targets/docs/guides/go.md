---
title: "Go toolchains"
description: "S.Go.Toolchain and the Go rule family: what keys a Go build, how package sets resolve, and what offline mode changes."
sidebar:
  order: 2
---

`S.Go.Toolchain` declares `go.mod`, `go.sum`, the version authority behind
them, the module-wide CGO policy, and any `GOEXPERIMENT` values. Planning
probes `go version` in the module directory, so a repository using
`GOTOOLCHAIN=auto` keys on the version Go actually selected rather than on the
one a file asked for.

Go rules run in the directory of the declared `go.mod`, so a module nested in
the workspace (`S.file("//typescript/tsc/go.mod")`) builds, tests and downloads
as one at the root does. `./` package patterns are relative to the declaring
package and `//` patterns to the workspace root; a directory pattern outside
the module refuses the target.

The executable rules are `S.Go.Test`, `S.Go.Binary`, `S.Go.ModDownload`,
`S.Go.Lint`, `S.Go.Generate`, and `S.Go.Fuzz`. `S.Go.bin` and
`S.Go.run("module/cmd@version")` are tool references rather than targets. Every
constructor rejects an attr it does not declare.

A shell target that runs `go` declares `tools: [S.Go.bin]`. Its `go` is then
the selected SDK's own executable, so the command never asks a launcher to
switch toolchains, which a closed network refuses.

## Package sets

`S.Go.Packages({ pkgs })` resolves a set of packages with `go list`, and
composes through `S.Files.difference` the way any other file set does. Targets
key on digests of the transitive Go files, cgo files and `go:embed` files that
`go list -deps -json` reports, so an edit outside that closure stays a cache
hit. `Go.Test`, `Go.Fuzz`, `Go.Generate` and `Go.Packages` add the test files
and test-only imports (`go list -deps -test`); `Go.Binary` does not, so a test
edit never rebuilds a binary.

A target that names a selection in `data` reads its closure: `go.mod`,
`go.sum` and every file above, test files included. A confined shell that runs
`go test` over the selection needs nothing else declared:

```ts
const packages = S.Go.Packages({ pkgs: ["./..."] })
S.Shell.Test({ shell: "./scripts/go-test-shards.sh", tools: [S.Go.bin], data: [packages], sandbox: {} })
```

## Compile cache

Go targets do not use the host's `GOCACHE`. Every `go` a target or the planner
starts runs with `GOCACHE` set to `go-build` inside the workspace's cache
directory, `.flows/go-build` by default. `smthrs cache status` reports its
size in `goBuild`. A shell target that runs `go` gets the same directory. To
point one target somewhere else, declare `GOCACHE` in its `env`.

On a host with many checkouts, set `SMITHERS_GO_CACHE` to an absolute
directory to share one compile cache between them. Unconfined targets
(`sandbox: "none"`) and planning use it; a confined target keeps the
workspace's own directory.

`smthrs cache prune --max-size 40GiB --yes` caps the directory, least recently
used entries first, and never removes an entry a running target may be
reading. Go's fuzz corpus cache in the same directory is not touched.

## Offline builds and key material

`offline: true` sets `GOPROXY=off` and appends `-mod=readonly` to the
declared `GOFLAGS`, so selectors and build flags stay:
`env: { GOFLAGS: "-run=^TestParse$ -trimpath" }` runs with
`-run=^TestParse$ -trimpath -mod=readonly`. A declared `-mod=vendor` is kept as
is. A declared `-mod=mod`, which lets `go` change the module graph, refuses an
offline target.

For a binary, the `goos`, `goarch`, CGO setting, experiments, ordinary
ldflags, and the resolved toolchain are all key material. Stamp values are
excluded: they resolve after the key is complete. See
[Build stamps](./stamps.md) for why.
