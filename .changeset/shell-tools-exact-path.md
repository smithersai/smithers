---
"@smthrs/build-cli": patch
---

A shell target's `tools` are the executables its command runs. Planning keyed
each declared tool by its bytes, but the spawn searched the host `PATH` again:
`tools: [S.Go.bin]` ran the Go launcher instead of the SDK it selected (a
confined launcher then tried to download that SDK), and a confined
`tools: [S.Host.bin("node")]` with a workspace-local Node first on `PATH` ran
the system Node. `PATH` now starts with a directory of links, one per declared
tool, to the exact executable the key identifies; a workspace-local tool is
admitted to the confinement as that one file. `Go.Generate` tools use the same
directory instead of putting their host directories into the keyed `env`. Two
tools with one name and different executables, or a tool name that is not a
command name, refuse the target. `S.Go.bin` and `S.Go.run` in `tools` also give
the command the toolchain's `CGO_ENABLED` and `GOEXPERIMENT`.

```ts
S.Shell.Test({ shell: "go vet ./...", tools: [S.Go.bin], data: [packages], sandbox: {} })
```
