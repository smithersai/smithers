import path from "node:path"

import { describe, expect, test } from "bun:test"

import { resolveDaemonEntrypointPath, resolveWebDistPath } from "./paths"

describe("path resolution", () => {
  test("resolves daemon entrypoint inside apps/daemon", () => {
    expect(resolveDaemonEntrypointPath()).toEndWith(
      path.join("apps", "daemon", "src", "main.ts")
    )
  })

  test("resolves bundled web build to top-level dist/web", () => {
    expect(resolveWebDistPath()).toEndWith(path.join("dist", "web"))
  })
})
