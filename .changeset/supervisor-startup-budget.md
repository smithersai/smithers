---
"@smthrs/platform-node": patch
"@smthrs/targets": patch
---

A command's own deadline bounds its supervisor's startup. The supervisor gave
every owner process 5 s to start, so on a loaded host a confined target with
`timeout: "5m"` failed with `The machine was too busy to start the process
within 5 s`. `ScopedProcess.spawn` takes `startupTimeoutMs` (default 5000).

```ts
ScopedProcess.spawn({ command: "node", args: ["--version"], startupTimeoutMs: 300_000 })
```
