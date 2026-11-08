import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { main } from "../../examples/09-browser-use.vibe"

const here = dirname(fileURLToPath(import.meta.url))

it.effect("runs on the in-memory engine", () =>
  Effect.gen(function*() {
    const summary = yield* (Effect.provide(main, NodeCrypto.layer))
    expect(summary.result).toBe("built web")
    expect(summary.stepKey).toBe(
      "key1_40330b52aa0c6d60b97d0bed12083cbc4a21fe7427873983ea5288d5db0f7b00"
    )
  }))

it("bundles for the browser with no node: imports", async () => {
  const result = await build({
    entryPoints: [join(here, "../../examples/09-browser-use.vibe")],
    absWorkingDir: join(here, ".."),
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "silent"
  })
  expect(result.outputFiles).toHaveLength(1)
  expect(result.outputFiles[0]!.text).toContain("examples/Compile")
})
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
