import path from "node:path"

import { describe, expect, test } from "bun:test"

import { resolveDaemonLifecyclePath } from "./paths"

describe("path resolution", () => {
  test("resolves daemon lifecycle inside apps/daemon", () => {
    expect(resolveDaemonLifecyclePath()).toEndWith(
      path.join("apps", "daemon", "src", "bootstrap", "daemon-lifecycle.ts")
    )
  })
})
