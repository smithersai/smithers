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

The executable rules are `S.Go.Test`, `S.Go.Binary`, `S.Go.ModDownload`,
`S.Go.Lint`, `S.Go.Generate`, and `S.Go.Fuzz`. `S.Go.bin` and
`S.Go.run("module/cmd@version")` are tool references rather than targets. Every
constructor rejects an attr it does not declare.

## Package sets

`S.Go.Packages({ pkgs })` resolves a set of packages with `go list`, and
composes through `S.Files.difference` the way any other file set does. Tests
and binaries key on digests of the transitive Go files, test files, cgo files,
and `go:embed` files that `go list -deps -json` reports, so an edit outside
that closure stays a cache hit.

## Compile cache

Go targets do not use the host's `GOCACHE`. Every `go` a target or the planner
starts runs with `GOCACHE` set to `go-build` inside the workspace's cache
directory, `.flows/go-build` by default. `smthrs cache status` reports its
size in `goBuild`. A shell target that runs `go` gets the same directory. To
point one target somewhere else, declare `GOCACHE` in its `env`.

## Offline builds and key material

`offline: true` adds `GOPROXY=off` and `GOFLAGS=-mod=readonly` to the run.

For a binary, the `goos`, `goarch`, CGO setting, experiments, ordinary
ldflags, and the resolved toolchain are all key material. Stamp values are
excluded: they resolve after the key is complete. See
[Build stamps](./stamps.md) for why.
