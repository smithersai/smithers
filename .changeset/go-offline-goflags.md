---
"@smthrs/build-cli": patch
---

`offline: true` keeps a Go rule's declared `GOFLAGS` and appends
`-mod=readonly`. It replaced the whole value, so `env: { GOFLAGS: "-run=^TestX$ -trimpath -p=8" }`
silently ran every test without `-trimpath`. A declared `-mod=vendor` is kept as
is; a declared `-mod=mod`, which can change the module graph, refuses an offline
target.
