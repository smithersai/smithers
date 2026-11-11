---
"@smthrs/targets": patch
---

`S.Workspace` takes a `remotes` option: `S.Remotes({ <name>: S.Remote.Command({ machines, workdir, setup?, cli? }) })`
declares the machines `smthrs ci --remote <name>` runs on, one argv prefix per machine.
