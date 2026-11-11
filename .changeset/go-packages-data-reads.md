---
"@smthrs/build-cli": patch
---

A `Go.Packages` selection named in a target's `data` admits its closure to that
target's confinement: `go.mod`, `go.sum` and every compiler input `go list`
reports, test files included. A confined shell consumer, such as a test shard
runner, read none of it before and failed with `main.go is outside the declared
read set`. The grant is exactly what the selection's key covers, and the
consumer keys on that key.

```ts
const packages = S.Go.Packages({ pkgs: ["./..."] })
S.Shell.Test({ shell: "./scripts/go-test-shards.sh", tools: [S.Go.bin], data: [packages], sandbox: {} })
```
