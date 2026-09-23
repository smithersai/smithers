import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHost from "../src/NodeHost.ts"

describe("NodeHost startup", () => {
  it.live("propagates a native executable's unsupported version as a typed construction failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-host-version-"))),
      (root) =>
        Effect.gen(function*() {
          // The host must propagate the real startup probe's typed refusal.
          // The running native binary reports a version that is not a jj version.
          const binary = process.execPath
          const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim()
          const previous = process.env.SMITHERS_JJ_PATH
          process.env.SMITHERS_JJ_PATH = binary
          try {
            const error = yield* Effect.flip(Effect.provide(Jj, NodeHost.layerAt(root)))
            expect(error).toMatchObject({ code: "unsupported_version", method: "version" })
            expect(error.message).toContain("0.39.0")
            expect(error.message).toContain(`found ${version}`)
          } finally {
            if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
            else process.env.SMITHERS_JJ_PATH = previous
          }
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))
})
